// Gets status of liquidpledging storage
import {mkdirSync, existsSync, readFileSync, writeFileSync} from "fs";

const path = require("path");
const config = require('config')
import {AdminInterface, EventInterface, PledgeInterface, ReportInterface} from "../utils/interfaces";
import {toFn} from "../utils/to";
import {getAdminBatch, getPledgeBatch} from "../utils/liquidPledgingHelper";
import {getLogger} from "../utils/logger";
import {LiquidPledging} from "giveth-liquidpledging";
import {LPPCappedMilestone} from 'lpp-capped-milestone';
import {BridgedMilestone, LPMilestone} from 'lpp-milestones';
import {LPVault} from 'giveth-liquidpledging';

const Web3 = require('web3');
const Web3WsProvider = require('web3-providers-ws');
const {liquidPledgingAddress} = config.get('blockchain');
import {keccak256, padLeft} from 'web3-utils';

const logger = getLogger();

function eventsCompare(firstEvent, secondEvent) {
  if (firstEvent.blockNumber < secondEvent.blockNumber) {
    return -1;
  }
  if (firstEvent.blockNumber > secondEvent.blockNumber) {
    return 1;
  }
  if (firstEvent.transactionIndex < secondEvent.transactionIndex) {
    return -1;
  }
  if (firstEvent.transactionIndex > secondEvent.transactionIndex) {
    return 1;
  }
  if (firstEvent.logIndex < secondEvent.logIndex) {
    return -1;
  }
  if (firstEvent.logIndex > secondEvent.logIndex) {
    return 1;
  }

  return 0;
}


const removeHexPrefix = hex => {
  if (hex && typeof hex === 'string' && hex.toLowerCase().startsWith('0x')) {
    return hex.substring(2);
  }
  return hex;
};

function getMilestoneTopics(liquidPledging) {
  const topics = [
    [
      // LPPCappedMilestone
      keccak256('MilestoneCompleteRequested(address,uint64)'),
      keccak256('MilestoneCompleteRequestRejected(address,uint64)'),
      keccak256('MilestoneCompleteRequestApproved(address,uint64)'),
      keccak256('MilestoneChangeReviewerRequested(address,uint64,address)'),
      keccak256('MilestoneReviewerChanged(address,uint64,address)'),
      keccak256('MilestoneChangeRecipientRequested(address,uint64,address)'),
      keccak256('MilestoneRecipientChanged(address,uint64,address)'),
      keccak256('PaymentCollected(address,uint64)'),

      // LPMilestone
      keccak256('RequestReview(address,uint64)'),
      keccak256('RejectCompleted(address,uint64)'),
      keccak256('ApproveCompleted(address,uint64)'),
      keccak256('ReviewerChanged(address,uint64,address)'),

      // BridgedMilestone - excluding duplicate topics
      keccak256('RecipientChanged(address,uint64,address)'),
    ],
    padLeft(`${(liquidPledging.$address).toLowerCase()}`, 64),
  ];
  console.log('getMilestoneTopics ', topics)
  return topics;
}

function decodeMilestone(web3, event) {
  const lppCappedMilestone = new LPPCappedMilestone(web3).$contract;
  const lpMilestone = new LPMilestone(web3).$contract;
  const bridgedMilestone = new BridgedMilestone(web3).$contract;
  const milestoneEventDecoder = lppCappedMilestone._decodeEventABI.bind({
    name: 'ALLEVENTS',
    jsonInterface: [
      ...lppCappedMilestone._jsonInterface,
      ...lpMilestone._jsonInterface,
      ...bridgedMilestone._jsonInterface,
    ],
  });
  return milestoneEventDecoder(event)
}

export const fetchBlockchainData = async (options: {
  cacheDir: string,
  report: ReportInterface,
  liquidPledging: any,
  foreignWeb3: any,
  kernel: any

}): Promise<{
  events: EventInterface[],
  pledges: PledgeInterface[],
  admins: AdminInterface []
}> => {
  const {
    cacheDir,
    report, liquidPledging,
    foreignWeb3, kernel
  } = options;
  console.log('fetchBlockchainData ....');
  const {vaultAddress} = config.get('blockchain');
  const lpVault = new LPVault(foreignWeb3, vaultAddress);
  try {
    if (!existsSync(cacheDir)) {
      mkdirSync(cacheDir);
    }
    const stateFile = path.join(cacheDir, `./liquidPledgingState_${process.env.NODE_ENV}.json`);
    const eventsFile = path.join(cacheDir, `./events_${process.env.NODE_ENV}.json`);
    const projectEventsFile = path.join(cacheDir, `./projectEvents_${process.env.NODE_ENV}.json`);
    const lpVaultEventsFile = path.join(cacheDir, `./lPVaultEvents_${process.env.NODE_ENV}.json`);
    const milestoneEventsFile = path.join(cacheDir, `./milestoneLogsEvents_${process.env.NODE_ENV}.json`);

    let state: {
      pledges: PledgeInterface[],
      admins: AdminInterface [],
    } = <{
      pledges: PledgeInterface[],
      admins: AdminInterface [],
    }>{
      pledges: [null],
      admins: [null],
    };
    if (existsSync(stateFile)) {
      state = JSON.parse(String(readFileSync(stateFile)));
    }
    let events: EventInterface[] = existsSync(eventsFile) ? JSON.parse(String(readFileSync(eventsFile))) : [];
    let projectEvents: EventInterface[] = existsSync(projectEventsFile) ? JSON.parse(String(readFileSync(projectEventsFile))) : [];
    let milestoneEvents: EventInterface[] = existsSync(milestoneEventsFile) ? JSON.parse(String(readFileSync(milestoneEventsFile))) : [];
    let lpVaultEvents: EventInterface[] = existsSync(lpVaultEventsFile) ? JSON.parse(String(readFileSync(lpVaultEventsFile))) : [];

    const eventsFromBlock = events.length > 0 ? events[events.length - 1].blockNumber + 1 : 0;
    const projectEventsFromBlock = projectEvents.length > 0 ? projectEvents[projectEvents.length - 1].blockNumber + 1 : 0;
    const lpVaultEventsFromBlock = lpVaultEvents.length > 0 ? lpVaultEvents[lpVaultEvents.length - 1].blockNumber + 1 : 0;
    const milestoneEventsFromBlock = milestoneEvents.length > 0 ? milestoneEvents[milestoneEvents.length - 1].blockNumber + 1 : 0;
    const toBlock =
      (await foreignWeb3.eth.getBlockNumber()) - config.get('blockchain.requiredConfirmations');
    const fromPledgeIndex = state.pledges.length > 1 ? state.pledges.length : 1;
    const fromPledgeAdminIndex = state.admins.length > 1 ? state.admins.length : 1;

    let newEvents: EventInterface[] = [];
    let newProjectEvents: EventInterface[] = [];
    let newMilestoneEvents: EventInterface[] = [];
    let newLpVaultEvents: EventInterface[] = [];
    let newPledges = [];
    let newAdmins = [];
    let dataFetched = false;
    let firstTry = true;
    while (
      !dataFetched
      // error ||
      // state.pledges.length <= 1 ||
      // state.admins.length <= 1
      ) {
      if (!firstTry) {
        logger.error('Some problem on fetching network info... Trying again!');
        if (!Array.isArray(state.pledges) || state.pledges.length <= 1) {
          logger.debug(`state.pledges: ${state.pledges}`);
        }
        if (!Array.isArray(state.admins) || state.admins.length <= 1) {
          logger.debug(`state.admins: ${state.admins}`);
        }
      }
      console.log('fromBlocks and toBlocks', {
        eventsFromBlock,
        projectEventsFromBlock,
        milestoneEventsFromBlock,
        lpVaultEventsFromBlock,
        toBlock,
      })
      const promises = [
        getPledgeBatch(liquidPledging, fromPledgeIndex),
        getAdminBatch(liquidPledging, fromPledgeAdminIndex),

        liquidPledging.$contract.getPastEvents('allEvents', {
          fromBlock: eventsFromBlock,
          toBlock,
        }),
        // Promise.resolve([]),

        kernel.$contract.getPastEvents({
          fromBlock: projectEventsFromBlock,
          toBlock,
          filter: {
            namespace: keccak256('base'),
            name: [
              keccak256('lpp-capped-milestone'),
              keccak256('lpp-lp-milestone'),
              keccak256('lpp-bridged-milestone'),
              keccak256('lpp-campaign'),
            ],
          },
        }),


        foreignWeb3.eth
          .getPastLogs({
              fromBlock: milestoneEventsFromBlock,
              toBlock,
              topics: getMilestoneTopics(liquidPledging),
          }),
        // Promise.resolve([]),

        lpVault.$contract.getPastEvents({
          fromBlock: lpVaultEventsFromBlock,
          toBlock
        })
      ]
      let [error, result] = await toFn(
        Promise.all(promises),
      );
      if (result) {
        [newPledges, newAdmins,
          newEvents, newProjectEvents,
          newMilestoneEvents,
          newLpVaultEvents] = result;
        dataFetched = true;
      }
      newMilestoneEvents = newMilestoneEvents.map(e => decodeMilestone(foreignWeb3, e))

      report.fetchedNewEventsCount = newEvents.length;
      report.fetchedNewPledgeCount = newPledges.length;
      report.fetchedNewPledgeAdminCount = newAdmins.length;

      if (error && error instanceof Error) {
        logger.error(`Error on fetching network info\n${error.stack}`);
      }
      firstTry = false;
    }


    state.pledges = [...state.pledges, ...newPledges];
    state.admins = [...state.admins, ...newAdmins];
    writeFileSync(stateFile, JSON.stringify(state, null, 2));

    events = [...events, ...newEvents];
    milestoneEvents = [...milestoneEvents, ...newMilestoneEvents];
    projectEvents = [...projectEvents, ...newProjectEvents];
    lpVaultEvents = [...lpVaultEvents, ...newLpVaultEvents];
    writeFileSync(eventsFile, JSON.stringify(events, null, 2));
    writeFileSync(lpVaultEventsFile, JSON.stringify(lpVaultEvents, null, 2));
    writeFileSync(projectEventsFile, JSON.stringify(projectEvents, null, 2));
    writeFileSync(milestoneEventsFile, JSON.stringify(milestoneEvents, null, 2));

    console.log('events and newEvents', {
      eventsLength: events.length,
      newEventsLength: newEvents.length,
      milestoneEvents: milestoneEvents.length,
      projectEvents: projectEvents.length,
      lpVaultEvents: lpVaultEvents.length,
    })
    events = events.concat(milestoneEvents, projectEvents, lpVaultEvents).sort(eventsCompare);

    report.processedEvents = events.length;

    return {
      pledges: state.pledges,
      admins: state.admins,
      events
    }

  } catch (e) {
    logger.error('fetchBlockchainData error', e);
    console.error('fetchBlockchainData error', e);
    throw e.stack;
  }

};


export const instantiateWeb3 = async (url: string): Promise<{
  liquidPledging: any,
  web3: any
}> => {
  const options = {
    timeout: 30000, // ms

    clientConfig: {
      // Useful if requests are large
      maxReceivedFrameSize: 100000000, // bytes - default: 1MiB
      maxReceivedMessageSize: 100000000, // bytes - default: 8MiB

      // Useful to keep a connection alive
      keepalive: true,
      keepaliveInterval: 45000, // ms
    },

    // Enable auto reconnection
    reconnect: {
      auto: true,
      delay: 5000, // ms
      maxAttempts: 5,
      onTimeout: false,
    },
  };

  if (!url || !url && url.startsWith('ws')) {
    throw new Error('invalid web3 websocket url');
  }
  const provider = new Web3WsProvider(url, options);
  let liquidPledging: any;
  return new Promise(resolve => {
    const web3 = new Web3(provider);
    if (provider.on) {
      provider.on('connect', () => {
        console.log(`connected to ${url}`);
        liquidPledging = new LiquidPledging(web3, liquidPledgingAddress);
        resolve({web3, liquidPledging});
      });
    } else {
      liquidPledging = new LiquidPledging(web3, liquidPledgingAddress);
      resolve({web3, liquidPledging});
    }
  });
};
