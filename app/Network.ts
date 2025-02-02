import {
  ContractWrapper,
  ContractWrapperFactory,
  IAgent,
  LensGetJobBytes32AndNextBlockSlasherIdResponse,
  NetworkConfig,
  Resolver,
} from './Types.js';
import { ethers } from 'ethers';
import { getAverageBlockTime, getExternalLensAddress, getMulticall2Address } from './ConfigGetters.js';
import { getExternalLensAbi, getMulticall2Abi } from './services/AbiService.js';
import { EthersContractWrapperFactory } from './clients/EthersContractWrapperFactory.js';
import EventEmitter from 'events';
import { App } from './App';
import logger from './services/Logger.js';

interface ResolverJobWithCallback {
  resolver: Resolver;
  callback: (calldata: string) => void;
}

interface TimeoutWithCallback {
  triggerCallbackAfter: number;
  callback: (blockNumber: number, blockTimestamp: number) => void;
}

export class Network {
  private initialized: boolean;
  private app: App;
  private readonly name: string;
  private readonly networkConfig: NetworkConfig;
  private readonly rpc: string;
  private chainId: number;
  private provider: ethers.providers.WebSocketProvider | undefined;
  private agents: IAgent[];
  private resolverJobData: { [key: string]: ResolverJobWithCallback };
  private timeoutData: { [key: string]: TimeoutWithCallback };
  private multicall: ContractWrapper | undefined;
  private externalLens: ContractWrapper | undefined;
  private averageBlockTimeSeconds: number;
  private externalLensAddress: string;
  private multicall2Address: string;
  private flashbotsAddress: string;
  private flashbotsPass: string;
  private flashbotsRpc: string;
  private newBlockNotifications: Map<number, Set<string>>;
  private contractWrapperFactory: ContractWrapperFactory;
  private newBlockEventEmitter: EventEmitter;

  private latestBaseFee: bigint;
  private latestBlockNumber: bigint;
  private latestBlockTimestamp: bigint;

  private toString(): string {
    return `(name: ${this.name}, rpc: ${this.rpc})`;
  }

  private clog(level: string, ...args: any[]) {
    logger.log(level, `Network${this.toString()}: ${args.join(' ')}`);
  }

  private err(...args: any[]): Error {
    return new Error(`NetworkError${this.toString()}: ${args.join(' ')}`);
  }

  constructor(name: string, networkConfig: NetworkConfig, app: App, agents: IAgent[]) {
    this.initialized = false;
    this.app = app;
    this.name = name;
    this.rpc = networkConfig.rpc;
    this.networkConfig = networkConfig;
    this.agents = agents;

    this.flashbotsRpc = networkConfig?.flashbots?.rpc;
    this.flashbotsAddress = networkConfig?.flashbots?.address;
    this.flashbotsPass = networkConfig?.flashbots?.pass;

    this.averageBlockTimeSeconds = networkConfig.average_block_time || getAverageBlockTime(name);
    this.externalLensAddress = networkConfig.external_lens || getExternalLensAddress(name, null, null);
    this.multicall2Address = networkConfig.multicall2 || getMulticall2Address(name);
    this.newBlockEventEmitter = new EventEmitter();

    this.newBlockNotifications = new Map();

    if (!this.rpc && !this.rpc.startsWith('ws')) {
      throw this.err(
        `Only WebSockets RPC endpoints are supported. The current value for '${this.getName()}' is '${this.rpc}'.`,
      );
    }

    this.resolverJobData = {};
    this.timeoutData = {};
  }

  public nowS(): number {
    return Math.floor(+new Date() / 1000);
  }

  public nowMs(): number {
    return +new Date();
  }

  public exitIfStrictTopic(topic) {
    this.app.exitIfStrictTopic(topic);
  }

  public getContractWrapperFactory(): ContractWrapperFactory {
    return this.contractWrapperFactory;
  }

  public getAverageBlockTimeSeconds(): number {
    return this.averageBlockTimeSeconds;
  }

  public getName(): string {
    return this.name;
  }

  public getChainId(): number {
    return this.chainId;
  }

  public getAgents(): IAgent[] {
    return this.agents;
  }

  public getAgent(agentAddress: string): IAgent {
    for (const agent of this.agents) {
      if (agent.address === agentAddress) {
        return agent;
      }
    }
    return null;
  }

  // TODO: throttle node requests
  public async getMaxPriorityFeePerGas(): Promise<number> {
    return this.provider.send('eth_maxPriorityFeePerGas', []);
  }

  public getFlashbotsRpc(): string {
    return this.flashbotsRpc;
  }

  public getFlashbotsAddress(): string {
    return this.flashbotsAddress;
  }

  public getFlashbotsPass(): string {
    return this.flashbotsPass;
  }

  public getExternalLensContract(): ContractWrapper {
    return this.externalLens;
  }

  public getProvider(): ethers.providers.WebSocketProvider {
    return this.provider;
  }

  public getBaseFee(): bigint {
    return this.latestBaseFee;
  }

  public getLatestBlockNumber(): bigint {
    return this.latestBlockNumber;
  }

  public getLatestBlockTimestamp(): bigint {
    return this.latestBlockTimestamp;
  }

  public getStatusObjectForApi(): object {
    const agents = this.agents.map((agent: IAgent) => {
      return {
        address: agent.address,
        keeperId: agent.getKeeperId(),
        workerAddress: agent.getKeyAddress(),
        executorType: agent.executorType,
        jobs: agent.getJobsCount(),
      };
    });
    const timeoutCallbacks = {};
    const nowSeconds = this.nowS();
    for (const [key, jobData] of Object.entries(this.timeoutData)) {
      timeoutCallbacks[key] = {
        callbackAt: jobData.triggerCallbackAfter,
        callbackIn: jobData.triggerCallbackAfter - nowSeconds,
      };
    }

    return {
      name: this.name,
      rpc: this.rpc,
      chainId: this.chainId,
      baseFee: this.getBaseFee(),
      latestBlockNumber: this.getLatestBlockNumber(),
      latestBlockTimestamp: this.getLatestBlockTimestamp(),
      getAverageBlockTime: this.averageBlockTimeSeconds,
      addresses: {
        externalLens: this.externalLensAddress,
        multicall: this.multicall2Address,
      },
      agents,
      timeoutCallbacks,
      resolverCallbacks: this.resolverJobData,
    };
  }

  private initProvider() {
    this.provider = new ethers.providers.WebSocketProvider(this.rpc);
    this.contractWrapperFactory = new EthersContractWrapperFactory([this.rpc], this.networkConfig.ws_timeout);
    this.multicall = this.contractWrapperFactory.build(this.multicall2Address, getMulticall2Abi());
    // TODO: initialize this after we know agent version and strategy
    this.externalLens = this.contractWrapperFactory.build(this.externalLensAddress, getExternalLensAbi());
    this.provider.on('block', this._onNewBlockCallback.bind(this));
  }

  public async init() {
    if (this.initialized) {
      throw this.err('Already initialized');
    }
    this.initialized = true;

    if (this.agents.length === 0) {
      this.clog('warning', `Ignoring '${this.getName()}' network setup as it has no agents configured.`);
      return;
    }

    this.initProvider();

    try {
      const latestBlock = await this.queryLatestBlock();

      this.latestBaseFee = BigInt(latestBlock.baseFeePerGas.toString());
      this.latestBlockNumber = BigInt(latestBlock.number.toString());
      this.latestBlockTimestamp = BigInt(latestBlock.timestamp.toString());
    } catch (e) {
      throw this.err(`Can't init '${this.getName()}' using '${this.rpc}': ${e}`);
    }

    this.chainId = await this.queryNetworkId();

    this.clog(
      'info',
      `The network '${this.getName()}' has been initialized. The last block number: ${this.latestBlockNumber}`,
    );
  }

  public stop() {
    this.provider?.removeAllListeners();
    this.contractWrapperFactory?.stop();
    this.provider = null;
    this.agents = null;
  }

  private async _onNewBlockCallback(blockNumber) {
    const before = this.nowMs();
    const block = await this.queryBlock(blockNumber);
    const fetchBlockDelay = this.nowMs() - before;

    this.latestBaseFee = BigInt(block.baseFeePerGas.toString());
    this.latestBlockNumber = BigInt(block.number.toString());
    this.latestBlockTimestamp = BigInt(block.timestamp.toString());

    this.newBlockEventEmitter.emit('newBlock', block.timestamp);

    if (this.newBlockNotifications.has(blockNumber)) {
      const emittedBlockHashes = this.newBlockNotifications.get(blockNumber);
      if (emittedBlockHashes && !emittedBlockHashes.has(block.hash)) {
        emittedBlockHashes.add(block.hash);
        this.walkThroughTheJobs(blockNumber, block.timestamp);
      }
    } else {
      this.newBlockNotifications.set(blockNumber, new Set([block.hash]));
      this.walkThroughTheJobs(blockNumber, block.timestamp);
    }
    if (process.env.NODE_ENV !== 'test') {
      this.clog(
        'info',
        `🧱 New block: (number=${blockNumber},timestamp=${block.timestamp},hash=${block.hash},txCount=${block.transactions.length},baseFee=${block.baseFeePerGas},fetchDelayMs=${fetchBlockDelay})`,
      );
    }
  }

  public getNewBlockEventEmitter(): EventEmitter {
    return this.newBlockEventEmitter;
  }

  private walkThroughTheJobs(blockNumber: number, blockTimestamp: number) {
    this.triggerIntervalCallbacks(blockNumber, blockTimestamp);
    this.callResolversAndTriggerCallbacks(blockNumber);
  }

  private async triggerIntervalCallbacks(blockNumber: number, blockTimestamp: number) {
    let callbacksCalled = 0;

    for (const [, jobData] of Object.entries(this.timeoutData)) {
      if (jobData.triggerCallbackAfter <= blockTimestamp) {
        // NOTICE: The callbacks are async, but we don't wait until the executions are finished
        jobData.callback(blockNumber, blockTimestamp);
        callbacksCalled++;
      }
    }

    this.clog('debug', `Block ${blockNumber} interval callbacks triggered: ${callbacksCalled}`);
  }

  private async callResolversAndTriggerCallbacks(blockNumber: number) {
    // TODO: split calls in chunks
    // TODO: protect from handlers queueing on the networks with < 3s block time
    const resolversToCall = [];
    const callbacks = [];
    for (const [, jobData] of Object.entries(this.resolverJobData)) {
      callbacks.push(jobData.callback);
      resolversToCall.push({
        target: jobData.resolver.resolverAddress,
        callData: jobData.resolver.resolverCalldata,
      });
      // TODO: let this.provider to be executed when making chunk requests;
    }
    if (callbacks.length === 0) {
      return;
    }

    const results = await this.queryPollResolvers(false, resolversToCall);
    let jobsToExecute = 0;

    for (let i = 0; i < results.length; i++) {
      const res = results[i];
      // Multicall-level success
      if (res.success) {
        const decoded = ethers.utils.defaultAbiCoder.decode(['bool', 'bytes'], res.returnData);
        if (decoded[0]) {
          callbacks[i](blockNumber, decoded[1]);
          jobsToExecute += 1;
        }
      }
    }

    this.clog(
      'debug',
      `Block ${blockNumber} resolver estimation results: (resolversToCall=${resolversToCall.length},jobsToExecute=${jobsToExecute})`,
    );
  }

  private _validateKeyLength(key: string, type: string): void {
    if (key.length < 3) {
      throw this.err(`Invalid callback key length: type=${type},key=${key}`);
    }
  }

  private _validateKeyNotInMap(key: string, map: { [key: string]: object }, type: string): void {
    if (map[key]) {
      throw this.err(`Callback key already exists: type=${type},key=${key}`);
    }
  }

  private _validateKeyInMap(key: string, map: { [key: string]: object }, type: string): void {
    if (!map[key]) {
      throw this.err(`Callback key already exists: type=${type},key=${key}`);
    }
  }

  public registerTimeout(key: string, triggerCallbackAfter: number, callback: (blockTimestamp: number) => void) {
    this._validateKeyLength(key, 'interval');
    this._validateKeyNotInMap(key, this.timeoutData, 'interval');
    this.clog(
      'debug',
      'SET Timeout',
      key,
      `at: ${triggerCallbackAfter}`,
      `now: ${this.nowS()}, in: ${triggerCallbackAfter - this.nowS()}`,
    );
    this.timeoutData[key] = {
      triggerCallbackAfter,
      callback,
    };
  }

  public unregisterTimeout(key: string) {
    this.clog('debug', 'UNSET Timeout', key);
    this._validateKeyLength(key, 'interval');
    delete this.timeoutData[key];
  }

  public registerResolver(key: string, resolver: Resolver, callback: (calldata: string) => void) {
    this._validateKeyLength(key, 'resolver');
    this._validateKeyNotInMap(key, this.resolverJobData, 'resolver');
    this.resolverJobData[key] = {
      resolver,
      callback,
    };
  }

  public unregisterResolver(key: string) {
    this._validateKeyLength(key, 'resolver');
    delete this.resolverJobData[key];
  }

  public async queryGasPrice(): Promise<number> {
    return (await this.provider.getGasPrice()).toNumber();
  }

  public async queryBlock(number): Promise<ethers.providers.Block> {
    return this.provider.getBlock(number);
  }

  public async queryLatestBlock(): Promise<ethers.providers.Block> {
    return this.provider.getBlock('latest');
  }

  public async queryNetworkId(): Promise<number> {
    return (await this.provider.getNetwork()).chainId;
  }

  public async queryPollResolvers(bl: boolean, resolversToCall: any[]): Promise<any> {
    return this.multicall.ethCallStatic('tryAggregate', [false, resolversToCall]);
  }

  public async queryLensJobsRawBytes32(agent: string, jobKey: string): Promise<string> {
    const res = await this.externalLens.ethCall('getJobsRawBytes32', [agent, [jobKey]]);
    return res.results[0];
  }

  public async queryLensJobs(agent: string, jobKeys: string[]): Promise<any> {
    return this.externalLens.ethCall('getJobs', [agent, jobKeys]);
  }

  public async queryLensOwnerBalances(agent: string, owners: string[]): Promise<any> {
    return this.externalLens.ethCall('getOwnerBalances', [agent, owners]);
  }

  public async queryLensJobBytes32AndNextBlockSlasherId(
    agent: string,
    jobKey: string,
  ): Promise<LensGetJobBytes32AndNextBlockSlasherIdResponse> {
    const res = await this.externalLens.ethCall('getJobBytes32AndNextBlockSlasherId', [agent, jobKey]);
    return { binJob: res.binJob, nextBlockSlasherId: res.nextBlockSlasherId.toNumber() };
  }
}
