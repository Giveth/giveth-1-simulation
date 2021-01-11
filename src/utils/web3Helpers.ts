/**
 * remove 0x prefix = require(hex string if present
 *
 * @param {string} hex
 */
import { transactionModel, TransactionMongooseDocument } from '../models/transactions.model';
import {getHomeTxHash} from "../services/homeTxHashService";
import {donationModel} from "../models/donations.model";
import {Types} from "mongoose";
export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

export const removeHexPrefix = hex => {
  if (hex && typeof hex === 'string' && hex.toLowerCase().startsWith('0x')) {
    return hex.substring(2);
  }
  return hex;
};

/**
 * recursively execute all requests in batches of 100
 *
 * @param {object} web3 Web3 instance
 * @param {array} requests array of Web3 request objects
 */
export function batchAndExecuteRequests(web3, requests) {
  if (requests.length === 0) return;
  try {
    const batch = new web3.BatchRequest();
    requests.splice(0, 100).forEach(r => batch.add(r));
    batch.execute();
    batchAndExecuteRequests(web3, requests);
  } catch (e) {
    //  console.log(e); TODO: Add appropriate log
  }
}

/**
 * Executes all provided web3 requests in a single batch call
 *
 * Each request should be a bound object with all args excluding the callback:
 *
 * ex.
 *
 * web3.eth.getBalance.request.bind(null, '0x0000000000000000000000000000000000000000', 'latest')
 *
 * where as the request would typically be called like:
 *
 * web3.eth.getBalance.request('0x0000000000000000000000000000000000000000', 'latest', callback);
 *
 * The response is a Promise that will resolve to an array of request responses
 * in the same order as the provided requests array
 *
 * @param {object} web3 Web3 instance
 * @param {array} requests array of Web3 request objects
 * @returns Promise
 */
export function executeRequestsAsBatch(web3, requests) {
  const batch = new web3.BatchRequest();

  const promise = Promise.all(
    requests.map(
      r =>
        new Promise((resolve, reject) => {
          batch.add(
            r((err, value) => {
              if (err) return reject(err);
              return resolve(value);
            }),
          );
        }),
    ),
  );

  batch.execute();

  return promise;
}


export async function getTransaction(
  options: { txHash: string, isHome?: boolean , foreignWeb3:any, homeWeb3:any},
): Promise<TransactionMongooseDocument> {
  const { txHash, isHome, foreignWeb3, homeWeb3 } = options;
  const web3 = isHome ? homeWeb3 : foreignWeb3;
  let transaction = await transactionModel.findOne(
    {
      hash: txHash, isHome,
      blockNumber: {$exists:true},
      timestamp: {$exists:true},
    });

  if (transaction) {
    return transaction;
  }
  const fetchedTransaction = await web3.eth.getTransaction(txHash);
  const { from, blockNumber } = fetchedTransaction;
  const { timestamp } = await web3.eth.getBlock(blockNumber);
  transaction = await transactionModel.findOneAndUpdate({ hash: txHash },
    {
      hash: txHash,
      from,
      blockNumber,
      timestamp: new Date(timestamp * 1000),
      isHome,
    }, { upsert: true, new: true });
  return transaction;

}


export async function getActionTakerAddress(options: {
  txHash: string,
  homeTxHash: string,
  foreignWeb3:any,
  homeWeb3:any
}) {
  const {txHash, homeTxHash, foreignWeb3, homeWeb3} = options;
  const {from} = await getTransaction({
    txHash: homeTxHash || txHash,
    isHome: Boolean(homeTxHash),
    foreignWeb3,
    homeWeb3
  });
  return from;
}

export async function getHomeTxHashForDonation(options:
                                          {
                                            txHash: string,
                                            parentDonations: string[],
                                            from: string,
                                            web3 :any
                                          }) :Promise<string>{
  const {txHash, parentDonations, from, web3} = options;
  if (from === '0') {
    return getHomeTxHash({
      txHash,
      web3
    });
  }
  if (parentDonations && parentDonations.length === 1) {
    const parentDonationWithHomeTxHash = await donationModel.findOne({
      _id: Types.ObjectId(parentDonations[0]),
      txHash,
      homeTxHash: {$exists: true},
    });
    if (parentDonationWithHomeTxHash) {
      return parentDonationWithHomeTxHash.homeTxHash;
    }
  }
  return null;
}
