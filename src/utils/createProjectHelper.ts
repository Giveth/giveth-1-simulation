import {keccak256} from 'web3-utils';
import {LPPCappedMilestone} from 'lpp-capped-milestone';
import {LPMilestone, BridgedMilestone} from 'lpp-milestones';
import {LPPCampaign} from 'lpp-campaign';
import {isAddress} from 'web3-utils';
import {
  removeHexPrefix,
  executeRequestsAsBatch,
  getTransaction,
} from './web3Helpers';
import {TraceTypes} from '../models/traces.model';
import {ANY_TOKEN, getTokenByForeignAddress} from './tokenUtility';
import {BaseCodeData, ProjectInterface} from './interfaces';
import {CommunityStatus} from '../models/communities.model';


let baseCodeData: BaseCodeData;
const getMilestoneAndCampaignBaseCodes = async (options: {
  kernel: any
}): Promise<BaseCodeData> => {
  const {kernel} = options;
  if (baseCodeData) {
    return baseCodeData
  }
  const [
    campaignBase,
    lppCappedMilestoneBase,
    lpMilestoneBase,
    bridgedMilestoneBase,
  ] = await Promise.all([
    kernel.getApp(keccak256(keccak256('base') + removeHexPrefix(keccak256('lpp-campaign')))),
    kernel.getApp(
      keccak256(keccak256('base') + removeHexPrefix(keccak256('lpp-capped-milestone'))),
    ),
    kernel.getApp(
      keccak256(keccak256('base') + removeHexPrefix(keccak256('lpp-lp-milestone'))),
    ),
    kernel.getApp(
      keccak256(keccak256('base') + removeHexPrefix(keccak256('lpp-bridged-milestone'))),
    ),
  ]);
  baseCodeData = {
    campaignBase,
    lppCappedMilestoneBase,
    lpMilestoneBase,
    bridgedMilestoneBase,
  };
  return baseCodeData;
};

const managerMethod = (traceType: string): string =>
  traceType === TraceTypes.LPPCappedMilestone ? 'milestoneManager' : 'manager';

const getCampaignReviewer = (options: { traceType: string, traceContract: any }): string => {
  const {traceType, traceContract} = options;
  traceType === TraceTypes.LPPCappedMilestone
    ? traceContract.campaignReviewer()
    : undefined;
  return traceType
};


const getTraceContract = (data: { web3: any, traceType: string, projectPlugin: string }) => {
  const {traceType, projectPlugin, web3} = data;
  switch (traceType) {
    case TraceTypes.LPPCappedMilestone:
      return new LPPCappedMilestone(web3, projectPlugin);
    case TraceTypes.LPMilestone:
      return new LPMilestone(web3, projectPlugin);
    case TraceTypes.BridgedMilestone:
      return new BridgedMilestone(web3, projectPlugin);
    default:
      throw new Error('Unknown Milestone type ->' + traceType);
  }
};


export const getTraceTypeByProjectId = async (
  options : {
    projectId: string,
    liquidPledging: any,
    AppProxyUpgradeable: any,
    web3:any,
    kernel:any
  }) => {
  const {
    projectId,
    liquidPledging,
    AppProxyUpgradeable,
    web3,
    kernel
  } = options
  const project = await liquidPledging.getPledgeAdmin(projectId);
  const baseCode = await new AppProxyUpgradeable(web3, project.plugin).implementation();
  const {
    campaignBase,
    lppCappedMilestoneBase,
    lpMilestoneBase,
    bridgedMilestoneBase,
  } = await getMilestoneAndCampaignBaseCodes({
    kernel
  });
  let isCampaign;
  let traceType;
  // eslint-disable-next-line default-case
  switch (baseCode) {
    case bridgedMilestoneBase:
      isCampaign = false;
      traceType = TraceTypes.BridgedMilestone;
      break;

    case lpMilestoneBase:
      isCampaign = false;
      traceType = TraceTypes.LPMilestone;
      break;

    case lppCappedMilestoneBase:
      isCampaign = false;
      traceType = TraceTypes.LPPCappedMilestone;
      break;

    case campaignBase:
      isCampaign = true;
      break;
  }

  // if isCampaign be true then traceType should be undefined and conversely
  return {
    isCampaign,
    traceType,
    project,
  };
}

export const getTraceDataForCreate = async (options: {
  traceType: string,
  project: ProjectInterface,
  projectId: string,
  txHash: string
  foreignWeb3:any,
  homeWeb3:any,
}) => {
  const {traceType, project,homeWeb3,
    foreignWeb3, projectId, txHash} = options;
  const traceContract = getTraceContract({
    traceType,
    projectPlugin: project.plugin,
    web3:foreignWeb3
  });
  const responses = await Promise.all([
    getCampaignReviewer({traceType, traceContract}),
    traceContract.recipient(),
    // batch what we can
    ...(await executeRequestsAsBatch(foreignWeb3, [
      traceContract.$contract.methods.maxAmount().call.request,
      traceContract.$contract.methods.reviewer().call.request,
      traceContract.$contract.methods[managerMethod(traceType)]().call.request,
      traceContract.$contract.methods.acceptedToken().call.request,
      foreignWeb3.eth.getTransaction.request.bind(null, txHash),
    ])),
  ]);
  const [
    campaignReviewer,
    recipient,
    maxAmount,
    reviewer,
    manager,
    acceptedToken,
    tx,
  ] = responses;
  const token = getTokenByForeignAddress(acceptedToken as string);
  if (!token) throw new Error(`Un-whitelisted token: ${acceptedToken}`);
  // const date = await getBlockTimestamp(web3, tx.blockNumber);
  const {timestamp} = await getTransaction({txHash: tx.hash, foreignWeb3, homeWeb3});
  return {
    title: project.name,
    description: 'Missing Description... Added outside of UI with simulation script',
    fiatAmount: maxAmount === '0' ? undefined : Number(maxAmount) / 10 ** 18,
    selectedFiatType: token.symbol === ANY_TOKEN.symbol ? undefined : token.symbol,
    date: timestamp,
    createdAt: timestamp,
    conversionRateTimestamp: maxAmount === '0' ? undefined : new Date(),
    conversionRate: maxAmount === '0' ? undefined : 1,
    projectId,
    maxAmount: maxAmount === '0' ? undefined : maxAmount,
    reviewerAddress: reviewer,
    recipientAddress: isAddress(recipient as string) ? recipient : undefined,
    recipientId: !isAddress(recipient as string) ? recipient : undefined,
    campaignReviewerAddress: campaignReviewer,
    txHash: tx.hash,
    pluginAddress: project.plugin,
    url: project.url,
    ownerAddress: manager,
    tokenAddress: token.address,
    totalDonated: '0',
    currentBalance: '0',
    isRecovered:true,
    donationCount: 0,
    mined: true,
    type: traceType,
  };
}

export const getCommunityDataForCreate = async (options: {
  from: string,
  txHash: string,
  delegateId: string,
  foreignWeb3:any,
  homeWeb3:any,
  liquidPledging: any,

}) => {
  const {
    txHash,
    delegateId,
    foreignWeb3,
    homeWeb3,
    liquidPledging
  } = options;
  const {from, timestamp} = await getTransaction({foreignWeb3, txHash, homeWeb3})
  const delegate = await liquidPledging.getPledgeAdmin(delegateId)
  return {
    createdAt: timestamp,
    ownerAddress: from,
    pluginAddress: delegate.plugin,
    title: delegate.name,
    commitTime: delegate.commitTime,
    url: delegate.url,
    txHash,
    delegateId,
    mined: true,
    status: CommunityStatus.RECOVERED,
    isRecovered:true,
    totalDonated: '0',
    currentBalance: '0',
    donationCount: 0,
    description: 'Missing Description... Added outside of UI with simulation script',
  }
}

export const getCampaignDataForCreate = async (options: {
  project: ProjectInterface,
  projectId: string,
  txHash: string,
  foreignWeb3:any,
  homeWeb3:any,

}) => {
  const {project, projectId, txHash, foreignWeb3, homeWeb3} = options;
  const lppCampaign = new LPPCampaign(foreignWeb3, project.plugin);

  const [reviewerAddress] = await executeRequestsAsBatch(foreignWeb3, [
    lppCampaign.$contract.methods.reviewer().call.request,
  ]);
  const {from, timestamp} = await getTransaction({txHash, foreignWeb3: foreignWeb3, homeWeb3});
  return {
    createdAt: timestamp,
    projectId,
    ownerAddress: from,
    coownerAddress: '0x0',
    fundsForwarder: '0x0',
    pluginAddress: project.plugin,
    reviewerAddress,
    title: project.name,
    image: '/',
    description: 'Missing Description... Added outside of UI with simulation script',
    txHash,
    totalDonated: '0',
    currentBalance: '0',
    donationCount: 0,
    commitTime: project.commitTime,
    url: project.url,
    isRecovered:true,
    mined: true,
  };
}

