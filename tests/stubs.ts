import sinon from 'sinon';
import { Network } from '../app/Network';
import { IAgent } from '../app/Types';
// @ts-ignore
import EventEmitter from 'events';
import { BigNumber, ethers } from 'ethers';
import { KEEPER_WORKER_ADDRESS } from './constants.js';

export function stubNetwork(network: Network) {
  // @ts-ignore
  sinon.stub(network, 'initProvider').callsFake(function () {
    return undefined;
    // JUST IGNORE
  });
  sinon.stub(network, 'queryLatestBlock').callsFake(async function () {
    // @ts-ignore
    return {
      baseFeePerGas: 2,
      number: 123,
      timestamp: 456,
    } as ethers.providers.Block;
  });
  sinon.stub(network, 'queryNetworkId').callsFake(async function () {
    return 42;
  });
  sinon.stub(network, 'queryLensJobs').callsFake(async function () {
    return [];
  });
  sinon.stub(network, 'queryLensOwnerBalances').callsFake(async function () {
    return [];
  });
}

export function stubAgent(agent: IAgent) {
  // @ts-ignore
  sinon.stub(agent, 'on').callsFake(function (eventName: string, callback: () => void) {
    if (!this.stubEventEmitter) {
      this.stubEventEmitter = new EventEmitter();
    }
    this.stubEventEmitter.on(eventName, callback);
    return this;
  });
  // @ts-ignore
  sinon.stub(agent, '_beforeInit').callsFake(function () {
    this.contract = 'contractStub';
  });
  // @ts-ignore
  sinon.stub(agent, 'initKeeperWorkerKey').callsFake(function () {
    this.workerSigner = {
      address: KEEPER_WORKER_ADDRESS,
    };
  });
  // @ts-ignore
  sinon.stub(agent, 'encodeABI').callsFake(function () {
    return 'Stub:encodedABI';
  });
  // @ts-ignore
  sinon.stub(agent, 'queryContractVersion').callsFake(async function () {
    return '2.3.0';
  });
  // @ts-ignore
  sinon.stub(agent, 'queryKeeperId').callsFake(async function () {
    return '3';
  });
  // @ts-ignore
  sinon.stub(agent, 'queryKeeperDetails').callsFake(async function () {
    return {
      currentStake: BigNumber.from('0x3635c9adc5dea00000'),
      isActive: true,
      worker: KEEPER_WORKER_ADDRESS,
    };
  });
  // @ts-ignore
  sinon.stub(agent, 'queryAgentConfig').callsFake(async function () {
    return {
      minKeeperCvp_: BigNumber.from('0x3635c9adc5dea00000'),
      pendingWithdrawalTimeoutSeconds_: BigNumber.from('0x0e10'),
      feeTotal_: BigNumber.from('0x00'),
      feePpm_: BigNumber.from('0x00'),
      lastKeeperId_: BigNumber.from('0x05'),
    };
  });
  // @ts-ignore
  sinon.stub(agent, 'queryAgentRdConfig').callsFake(async function () {
    return {
      slashingEpochBlocks: 10,
      period1: 90,
      period2: 120,
      slashingFeeFixedCVP: 50,
      slashingFeeBps: 300,
      jobMinCreditsFinney: 10,
      agentMaxCvpStake: 5000,
      jobCompensationMultiplierBps: 11000,
      stakeDivisor: 50000000,
      keeperActivationTimeoutHours: 1,
    };
  });
  // @ts-ignore
  sinon.stub(agent, 'queryPastEvents').callsFake(async function () {
    return [];
  });
}

// New test case that simulates the conditions under which silent failures or stoppages in event tracking might occur
describe('Silent Slashing Swindle bug', () => {
  it('should correctly handle the conditions under which the bug occurs', async () => {
    // Create a new instance of the RandaoJob class
    const randaoJob = new RandaoJob(/* parameters to match the conditions under which the bug occurs */);

    // Call the methods that are supposed to track the execution of tasks and handle slashing events
    randaoJob.applyKeeperAssigned(/* parameters */);
    randaoJob.applyInitiateKeeperSlashing(/* parameters */);
    randaoJob.applySlashKeeper(/* parameters */);

    // Simulate the conditions under which silent failures or stoppages in event tracking might occur
    /* code to simulate these conditions */

    // Call the checkForEventTrackingFailures function
    randaoJob.checkForEventTrackingFailures();

    // Check if the function correctly detects these conditions and sends an alert
    assert(/* condition */);
  });
});
