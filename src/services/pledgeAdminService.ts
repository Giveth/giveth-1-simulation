import {createProjectHelper} from "../utils/createProjectHelper";
import {createProgressBar} from "../utils/progressBar";
import {EventInterface, ReportInterface} from "../utils/interfaces";
import {AdminTypes, pledgeAdminModel} from "../models/pledgeAdmins.model";
import {campaignModel, CampaignStatus} from "../models/campaigns.model";
import {milestoneModel, MilestoneStatus} from "../models/milestones.model";
import {getLogger} from "../utils/logger";

const logger = getLogger()


const createMilestoneForPledgeAdmin = async ({
                                                 project, getMilestoneDataForCreate,
                                                 idProject, milestoneType, transactionHash,
                                             }) => {
    const campaign = await campaignModel.findOne({ projectId: project.parentProject });
    if (!campaign) {
        logger.error(`Campaign doesn't exist -> projectId:${idProject}`);
        return undefined;
    }
    const createMilestoneData = await getMilestoneDataForCreate({
        milestoneType,
        project,
        projectId: idProject,
        txHash: transactionHash,
    });
    return new milestoneModel({
        ...createMilestoneData,
        status: MilestoneStatus.PENDING,
        campaignId: campaign._id,
    }).save();
};
const createCampaignForPledgeAdmin = async ({ project, idProject, transactionHash, getCampaignDataForCreate }) => {
    const createCampaignData = await getCampaignDataForCreate({
        project,
        projectId: idProject,
        txHash: transactionHash,
    });
    return new campaignModel({
        ...createCampaignData,
        status: CampaignStatus.CANCELED,
    }).save();
};

const createPledgeAdminAndProjectsIfNeeded = async (options:
                                                        {
                                                            getMilestoneTypeByProjectId,
                                                            getMilestoneDataForCreate,
                                                            getCampaignDataForCreate,
                                                            event: string,
                                                            report:ReportInterface,
                                                            transactionHash: string,
                                                            returnValues: {
                                                                idProject: string
                                                            }
                                                        }) => {
    const {
        event, transactionHash, returnValues, getCampaignDataForCreate,
        getMilestoneTypeByProjectId, getMilestoneDataForCreate,
        report
    } = options;
    if (event !== 'ProjectAdded') return;
    try {
        const { idProject } = returnValues;
        const pledgeAdmin = await pledgeAdminModel.findOne({ id: Number(idProject) });
        if (pledgeAdmin) {
            return;
        }
        logger.error(`No pledge admin exists for ${idProject}`);
        logger.info('Transaction Hash:', transactionHash);

        const { project, milestoneType, isCampaign } = await getMilestoneTypeByProjectId(idProject);
        let entity = isCampaign
            ? await campaignModel.findOne({ txHash: transactionHash })
            : await milestoneModel.findOne({ txHash: transactionHash });
        // Not found any
        if (!entity && !isCampaign) {
            try {
                entity = await createMilestoneForPledgeAdmin({
                    project,
                    idProject,
                    milestoneType,
                    transactionHash,
                    getMilestoneDataForCreate,
                });
                report.createdMilestones++;
            } catch (e) {
                logger.error('createMilestoneForPledgeAdmin error', { idProject, e });
                await new pledgeAdminModel({
                    id: Number(idProject),
                    type: AdminTypes.MILESTONE,
                    typeId: 'notExists because create milestone failed',
                }).save();
                logger.error('create pledgeAdmin without creating milestone', { idProject });
            }
        } else if (!entity && isCampaign) {
            entity = await createCampaignForPledgeAdmin({ project, idProject, transactionHash, getCampaignDataForCreate });
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
    options:{
        fixConflicts:boolean,
        events: EventInterface[],
        report: ReportInterface,
        homeWeb3:any,
        foreignWeb3:any,
        liquidPledging:any,
        kernel:any,
        AppProxyUpgradeable:any
    }
) => {
    const {fixConflicts, homeWeb3, foreignWeb3,
        liquidPledging, kernel,
        events, AppProxyUpgradeable,
        report} = options;
    console.log('syncPledgeAdminsAndProjects called', { fixConflicts });
    if (!fixConflicts) return;
    const {
        getMilestoneTypeByProjectId,
        getCampaignDataForCreate,
        getMilestoneDataForCreate,
    } = await createProjectHelper({
        web3: foreignWeb3,
        homeWeb3,
        liquidPledging,
        kernel,
        AppProxyUpgradeable,
    });

    const startTime = new Date();
    console.log('Syncing PledgeAdmins with events .... ');
    const progressBar = createProgressBar({ title: 'Syncing pladgeAdmins with events' });
    progressBar.start(events.length, 0);
    for (let i = 0; i < events.length; i += 1) {
        progressBar.update(i);

        const { event, transactionHash, returnValues } = events[i];
        await createPledgeAdminAndProjectsIfNeeded({
            getCampaignDataForCreate,
            getMilestoneDataForCreate,
            getMilestoneTypeByProjectId,
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
