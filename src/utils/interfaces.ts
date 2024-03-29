import {DonationMongooseDocument} from '../models/donations.model';
import {Admin} from 'mongodb';
import {PledgeAdminMongooseDocument} from '../models/pledgeAdmins.model';

export interface EventReturnValues {
  from: string,
  to: string,
  0: string,
  1: string,
  idProject: string,
  idDelegate: string,
  url: string
  amount?: string
}

export interface EventInterface {
  // address: string,
  blockNumber: number,
  transactionHash: string,
  signature?: string,
  raw?: any,
  // transactionIndex: number,
  // blockHash: string,
  logIndex: number,
  // removed: boolean,
  id?: string,
  returnValues: EventReturnValues,
  event: string,
}


export interface PledgeInterface {
  delegates: { id: string } [],
  owner: string,
  token: string,
  intendedProject: string,
  commmitTime: string,
  oldPledge: string,
  pledgeState: string,
  amount?: string
}

export interface AdminInterface {
  type: string,
  addr: string,
  name: string,
  url: string,
  commitTime: string,
  plugin: string
  parentProject: string,
  canceled: boolean,

  isCanceled?: boolean,

}

export interface DelegateInfoInterface {
  delegateId: string | number,
  delegateTypeId: string,
  delegateType: string,
  intendedProjectType: string,
  intendedProjectTypeId: string,
  intendedProjectId: string | number,
}


export interface ExtendedDonation extends DonationMongooseDocument {
  savedStatus?: string,
  savedAmountRemaining?: string,
}


export interface DonationListObjectInterface {
  [key: string]: ExtendedDonation[]
}

export interface DonationObjectInterface {
  [key: string]: ExtendedDonation
}

export interface TransferInfoInterface {
  fromPledge: PledgeInterface,
  fromPledgeAdmin: PledgeAdminMongooseDocument,
  toPledgeAdmin: PledgeAdminMongooseDocument,
  toPledgeId: string,
  txHash: string,
  fromPledgeId: string
}

export interface ProjectInterface {
  plugin: string,
  url: string,
  name: string,
  commitTime: string
}

export interface ReportInterface {
  syncDelegatesSpentTime: number,
  syncProjectsSpentTime: number,
  syncDonationsSpentTime: number,
  syncPledgeAdminsSpentTime: number,
  syncTraceSpentTime: number,
  createdCommunities: number,
  createdCampaigns: number,
  createdTraces: number,
  createdDonations: number,
  updatedDonations: number,
  updatedDonationsMined: number,
  updatedDonationsParent: number,
  updateAmountRemaining: number,
  deletedDonations: number,
  createdPledgeAdmins: number,
  processedEvents: number,
  correctFailedDonations: number,
  fetchedNewPledgeCount: number,
  fetchedNewPledgeAdminCount: number,
  fetchedNewEventsCount: number,
  removedPendingAmountRemainingCount: number,
  updatedTraceStatus: number,
  addedEventsToDb: number,
}

export interface Token {
  symbol: string,
  name: string,
  address: string,
  foreignAddress: string,
  decimals: number,
  rateEqSymbol?: string
}

export interface BaseCodeData {
  campaignBase: any,
  lppCappedMilestoneBase: any,
  lpMilestoneBase: any,
  bridgedMilestoneBase: any,
}