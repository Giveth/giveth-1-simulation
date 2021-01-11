import {keccak256} from "web3-utils";
import {toFn} from "../utils/to";
import {getLogger} from "../utils/logger";
const Contract = require('web3-eth-contract');
const ForeignGivethBridgeArtifact = require('giveth-bridge/build/ForeignGivethBridge.json');
const logger = getLogger()
function eventDecodersFromArtifact(artifact) {
    return artifact.compilerOutput.abi
        .filter(method => method.type === 'event')
        .reduce(
            (decoders, event) => ({
                ...decoders,
                [event.name]: Contract.prototype._decodeEventABI.bind(event),
            }),
            {},
        );
}

function topicsFromArtifacts(artifacts, names) {
    return artifacts
        .reduce(
            (accumulator, artifact) =>
                accumulator.concat(
                    artifact.compilerOutput.abi.filter(
                        method => method.type === 'event' && names.includes(method.name),
                    ),
                ),
            [],
        )
        .reduce(
            (accumulator, event) =>
                accumulator.concat({
                    name: event.name,
                    hash: keccak256(`${event.name}(${event.inputs.map(i => i.type).join(',')})`),
                }),
            [],
        );
}

export async function getHomeTxHash(options :{txHash: string, web3:any}) {
    const {txHash, web3} = options;
    const decoders = eventDecodersFromArtifact(ForeignGivethBridgeArtifact);
    const [err, receipt] = await toFn(web3.eth.getTransactionReceipt(txHash));
    if (err || !receipt) {
        logger.error('Error fetching transaction, or no tx receipt found ->', err, receipt);
        return undefined;
    }
    const topics = topicsFromArtifacts([ForeignGivethBridgeArtifact], ['Deposit']);
    // get logs we're interested in.
    const logs = receipt.logs.filter(log => topics.some(t => t.hash === log.topics[0]));
    if (logs.length === 0) return undefined;
    const log = logs[0];
    const topic = topics.find(t => t.hash === log.topics[0]);
    const event = decoders[topic.name](log);

    return event.returnValues.homeTx;
}