
// Gets status of liquidpledging storage
import {mkdirSync, existsSync, readFileSync, writeFileSync} from "fs";
const path = require("path");
const config = require('config')
import {AdminInterface, EventInterface, PledgeInterface, ReportInterface} from "../utils/interfaces";
import {toFn} from "../utils/to";
import {getAdminBatch, getPledgeBatch} from "../utils/liquidPledgingHelper";
import {getLogger} from "../utils/logger";
import {LiquidPledging} from "giveth-liquidpledging";
const Web3 = require('web3');
const Web3WsProvider = require('web3-providers-ws');
const { liquidPledgingAddress } = config.get('blockchain');

const logger = getLogger();
export const fetchBlockchainData = async (options :{
    updateEvents:boolean,
    updateState: boolean,
    cacheDir: string,
    report: ReportInterface,
    liquidPledging:any,
    foreignWeb3:any

}) :Promise< {
    events: EventInterface[],
    pledges: PledgeInterface[],
    admins: AdminInterface []}>=> {
    const {
        updateEvents,
        updateState, cacheDir,
         report,liquidPledging,
        foreignWeb3
    } = options;
    console.log('fetchBlockchainData ....', {
        updateEvents,
        updateState,
    });
    let events: EventInterface[];
    try {
        if (!existsSync(cacheDir)) {
            mkdirSync(cacheDir);
        }
        const stateFile = path.join(cacheDir, `./liquidPledgingState_${process.env.NODE_ENV}.json`);
        const eventsFile = path.join(cacheDir, `./liquidPledgingEvents_${process.env.NODE_ENV}.json`);

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
        events = existsSync(eventsFile) ? JSON.parse(String(readFileSync(eventsFile))) : [];

        if (updateState || updateEvents) {
            let fromBlock = 0;
            let fetchBlockNum: string | number = 'latest';
            if (updateEvents) {
                fromBlock = events.length > 0 ? events[events.length - 1].blockNumber + 1 : 0;
                fetchBlockNum =
                    (await foreignWeb3.eth.getBlockNumber()) - config.get('blockchain.requiredConfirmations');
            }

            const fromPledgeIndex = state.pledges.length > 1 ? state.pledges.length : 1;
            const fromPledgeAdminIndex = state.admins.length > 1 ? state.admins.length : 1;

            let newEvents = [];
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
                let [error, result] = await toFn(
                    Promise.all([
                        updateState ? getPledgeBatch(liquidPledging, fromPledgeIndex) : Promise.resolve(state.pledges),
                        updateState ? getAdminBatch(liquidPledging, fromPledgeAdminIndex) : Promise.resolve(state.admins),
                        updateEvents
                            ? liquidPledging.$contract.getPastEvents('allEvents', {
                                fromBlock,
                                toBlock: fetchBlockNum,
                            })
                            : Promise.resolve([]),
                    ]),
                );
                if (result) {
                    [newPledges, newAdmins, newEvents] = result;
                    dataFetched = true;
                }

                report.fetchedNewEventsCount = newEvents.length;
                report.fetchedNewPledgeCount = newPledges.length;
                report.fetchedNewPledgeAdminCount = newAdmins.length;

                if (error && error instanceof Error) {
                    logger.error(`Error on fetching network info\n${error.stack}`);
                }
                firstTry = false;
            }


            if (updateState) {
                state.pledges = [...state.pledges, ...newPledges];
                state.admins = [...state.admins, ...newAdmins];
                writeFileSync(stateFile, JSON.stringify(state, null, 2));
            }
            if (updateEvents && newEvents) {
                events = [...events, ...newEvents];
                writeFileSync(eventsFile, JSON.stringify(events, null, 2));
            }
        }


        report.processedEvents = events.length;

        return {
            pledges : state.pledges,
            admins : state.admins,
            events
        }

    } catch (e) {
        logger.error('fetchBlockchainData error', e);
        console.error('fetchBlockchainData error', e);
        throw e.stack;
    }

};


export const instantiateWeb3 = async (url :string) :Promise<{
    liquidPledging:any,
    web3: any
}>=> {
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
