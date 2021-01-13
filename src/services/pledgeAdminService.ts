import {
  getCampaignDataForCreate,
  getMilestoneDataForCreate,
  getMilestoneTypeByProjectId
} from "../utils/createProjectHelper";
import {createProgressBar} from "../utils/progressBar";
import {EventInterface, ReportInterface} from "../utils/interfaces";
import {AdminTypes, pledgeAdminModel} from "../models/pledgeAdmins.model";
import {campaignModel, CampaignStatus} from "../models/campaigns.model";
import {milestoneModel, MilestoneStatus} from "../models/milestones.model";
import {getLogger} from "../utils/logger";

const logger = getLogger()


const createMilestoneForPledgeAdmin = async (options: {
  project: any,
  idProject: string,
  milestoneType: string, transactionHash: string,
  foreignWeb3: any, homeWeb3: any
}) => {
  const {
    project, foreignWeb3, homeWeb3,
    idProject, milestoneType, transactionHash,
  } = options;
  const campaign = await campaignModel.findOne({projectId: project.parentProject});
  if (!campaign) {
    logger.error(`Campaign doesn't exist -> projectId:${idProject}`);
    return undefined;
  }
  const createMilestoneData = await getMilestoneDataForCreate({
    foreignWeb3,
    homeWeb3,
    milestoneType,
    project,
    projectId: idProject,
    txHash: transactionHash,
  });
  return new milestoneModel({
    ...createMilestoneData,
    status: MilestoneStatus.RECOVERED,
    campaignId: campaign._id,
  }).save();
};
const createCampaignForPledgeAdmin = async (options:
                                              {
                                                homeWeb3: any,
                                                foreignWeb3: any,
                                                project: any,
                                                idProject: string,
                                                transactionHash: string
                                              }) => {
  const {project, idProject, transactionHash, homeWeb3, foreignWeb3} = options;
  const createCampaignData = await getCampaignDataForCreate({
    project,
    projectId: idProject,
    txHash: transactionHash,
    foreignWeb3,
    homeWeb3
  });
  return new campaignModel({
    ...createCampaignData,
    status: CampaignStatus.RECOVERED,
  }).save();
};

const createPledgeAdminAndProjectsIfNeeded = async (options:
                                                      {
                                                        kernel: any,
                                                        homeWeb3: any,
                                                        foreignWeb3: any,
                                                        liquidPledging,
                                                        AppProxyUpgradeable
                                                        event: string,
                                                        report: ReportInterface,
                                                        transactionHash: string,
                                                        returnValues: {
                                                          idProject: string
                                                        }
                                                      }) => {
  const {
    event, transactionHash, returnValues,
    report, kernel,
    homeWeb3, foreignWeb3, liquidPledging,
    AppProxyUpgradeable
  } = options;

  if (event !== 'ProjectAdded') return;
  try {
    const {idProject} = returnValues;
    const pledgeAdmin = await pledgeAdminModel.findOne({id: Number(idProject)});
    if (pledgeAdmin) {
      return;
    }
    logger.error(`No pledge admin exists for ${idProject}`);
    logger.info('Transaction Hash:', transactionHash);

    const {project, milestoneType, isCampaign} = await getMilestoneTypeByProjectId({
      kernel,
      web3: foreignWeb3,
      projectId: idProject,
      liquidPledging,
      AppProxyUpgradeable
    });
    let entity = isCampaign
      ? await campaignModel.findOne({txHash: transactionHash})
      : await milestoneModel.findOne({txHash: transactionHash});
    // Not found any
    if (!entity && !isCampaign) {
      try {
        entity = await createMilestoneForPledgeAdmin({
          project,
          idProject,
          milestoneType,
          transactionHash,
          foreignWeb3,
          homeWeb3
        });
        report.createdMilestones++;
      } catch (e) {
        logger.error('createMilestoneForPledgeAdmin error', {idProject, e});
        await new pledgeAdminModel({
          id: Number(idProject),
          type: AdminTypes.MILESTONE,
          typeId: 'notExists because create milestone failed',
          isRecovered :true
        }).save();
        logger.error('create pledgeAdmin without creating milestone', {idProject});
      }
    } else if (!entity && isCampaign) {
      entity = await createCampaignForPledgeAdmin({
        project,
        idProject,
        homeWeb3,
        foreignWeb3,
        transactionHash
      });
      report.createdCampaigns++;
    }
    if (!entity) {
      return;
    }

    logger.info('created entity ', entity);
    const type = isCampaign ? AdminTypes.CAMPAIGN : AdminTypes.MILESTONE;
    logger.info(`a ${type} found with id ${entity._id.toString()} and status ${entity.status}`);
    logger.info(`Title: ${entity.title}`);
    const newPledgeAdmin = new pledgeAdminModel({
      id: Number(idProject),
      type,
      typeId: entity._id.toString(),
      isRecovered :true
    });
    const result = await newPledgeAdmin.save();
    report.createdPledgeAdmins++;
    logger.info('pledgeAdmin saved', result);
  } catch (e) {
    console.log('createPledgeAdminAndProjectsIfNeeded error', {
      e,
      event,
      transactionHash,
      returnValues
    })
  }
  // process.stdout.write('.');
};


export const syncPledgeAdminsAndProjects = async (
  options: {
    fixConflicts: boolean,
    events: EventInterface[],
    report: ReportInterface,
    homeWeb3: any,
    foreignWeb3: any,
    liquidPledging: any,
    kernel: any,
    AppProxyUpgradeable: any
  }
) => {
  const {
    fixConflicts, homeWeb3, foreignWeb3,
    liquidPledging, kernel,
    events, AppProxyUpgradeable,
    report
  } = options;
  console.log('syncPledgeAdminsAndProjects called', {fixConflicts});
  if (!fixConflicts) return;
  const startTime = new Date();
  console.log('Syncing PledgeAdmins with events .... ');
  const progressBar = createProgressBar({title: 'Syncing pladgeAdmins with events'});
  progressBar.start(events.length, 0);
  for (let i = 0; i < events.length; i += 1) {
    progressBar.update(i);
    const {event, transactionHash, returnValues} = events[i];
    await createPledgeAdminAndProjectsIfNeeded({
      kernel,
      foreignWeb3,
      homeWeb3,
      liquidPledging,
      AppProxyUpgradeable,
      event,
      transactionHash,
      returnValues,
      report
    })
  }
  progressBar.update(events.length);
  progressBar.stop();
  const spentTime = (new Date().getTime() - startTime.getTime()) / 1000;
  report.syncPledgeAdminsSpentTime = spentTime;
  console.log(`pledgeAdmins events synced end.\n spentTime :${spentTime} seconds`);
};
