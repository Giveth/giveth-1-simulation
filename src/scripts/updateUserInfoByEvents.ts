/**
 * This script find users that dont have name and with getting events from db
 * and fetch transaction info from rinkeby and update in db
 */

import {instantiateWeb3} from "../services/blockChainService";
import * as mongoose from 'mongoose';
import {userModel, UserMongooseDocument} from "../models/users.model";
import {eventModel} from "../models/events.model";
import {pledgeAdminModel, PledgeAdminMongooseDocument} from "../models/pledgeAdmins.model";

const config = require('config')
const {nodeUrl} = config.get('blockchain');

const InputDataDecoder = require("ethereum-input-data-decoder")

const LiquidPledging = require('giveth-liquidpledging/build/LiquidPledging.json');

const getNameAndUrlFromUpdateGiverTransactionInput = (input: string): {
  name: string,
  url: string
} => {
  const decoder = new InputDataDecoder(LiquidPledging.compilerOutput.abi);
  const result = decoder.decodeData(input);
  const name = result.inputs[result.names.indexOf('newName')]
  const url = result.inputs[result.names.indexOf('newUrl')]
  return {
    name, url
  }
}

const getNameAndUrlFromAddGiverTransactionInput = (input: string): {
  name: string,
  url: string
} => {
  const decoder = new InputDataDecoder(LiquidPledging.compilerOutput.abi);
  const result = decoder.decodeData(input);
  const name = result.inputs[result.names.indexOf('name')]
  const url = result.inputs[result.names.indexOf('url')]
  return {
    name, url
  }
}

const updateUserInfo = async (data: {
  address: string,
  web3: any
}) => {
  const {address, web3} = data
  const pledgeAdmins = await pledgeAdminModel.find({
    typeId:address,
    type:'giver'
  }).sort({createdAt: -1});
  // console.log('pledgeAdmins length', pledgeAdmins.length)
  for (const  pledgeAdmin  of pledgeAdmins){
    const giverId = String(pledgeAdmin.id);
    let event = await eventModel.findOne({
      event: 'GiverUpdated',
      'returnValues.idGiver': giverId
    }).sort({createdAt: -1});
    if (!event) {
      event = await eventModel.findOne({
        event: 'GiverAdded',
        'returnValues.idGiver': giverId
      }).sort({createdAt: -1});
    }
    if (!event) {
      return;
    }
    const transaction = await web3.eth.getTransaction(event.transactionHash)
    if (!transaction) {
      return
    }
    let userInfo: {
      name: string,
      url: string
    }
    if (event.event === 'GiverUpdated') {
      userInfo = await getNameAndUrlFromUpdateGiverTransactionInput(transaction.input)
    } else {
      userInfo = await getNameAndUrlFromAddGiverTransactionInput(transaction.input)
    }
    if (userInfo.name || userInfo.url) {
      console.log('updated user ', {...userInfo, address})
      // await userModel.findOneAndUpdate({address}, userInfo)
      continue;
    }
  }


}

const main = async () => {
  const web3 = (await instantiateWeb3(nodeUrl)).web3;
  console.log('connected to web3')
  const usersWithoutNames = await userModel.find({
    name: ''
  });
  for (const user of usersWithoutNames) {
    await updateUserInfo({address:user.address, web3})
  }
}
const mongoUrl = config.get('mongodb') as string;
mongoose.connect(mongoUrl);
const db = mongoose.connection;

db.on('error', err => {
  console.error(`Could not connect to Mongo:\n${err.stack}`)
  throw err;
});

db.once('open', async () => {
  console.info('Connected to Mongo');
  try {
    await main()
    process.exit(0)
  } catch (e) {
    console.log('error', e)
    throw e;
  }
});
