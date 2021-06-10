import {getCommunityDataForCreate} from "../utils/createProjectHelper";
import {pledgeAdminModel} from "../models/pledgeAdmins.model";
import {getTransaction} from "../utils/web3Helpers";
import {communityModel} from "../models/communities.model";
import {createProgressBar} from "../utils/progressBar";
import {EventInterface, ReportInterface} from "../utils/interfaces";
import {getLogger} from "../utils/logger";

const logger = getLogger();
export const syncCommunities = async (options:{
    fixConflicts:boolean,
    events: EventInterface[],
    report: ReportInterface,
    homeWeb3:any,
    foreignWeb3:any,
    liquidPledging:any,
    kernel:any,
    AppProxyUpgradeable:any
}) => {
    const {fixConflicts, homeWeb3, foreignWeb3,
        liquidPledging, kernel,
        events, AppProxyUpgradeable,
    report} = options;
    console.log('syncCommunities called', { fixConflicts });
    if (!fixConflicts) return;
    const startTime = new Date();
    const progressBar = createProgressBar({ title: 'Syncing Communities with events' });
    progressBar.start(events.length, 0);
    for (let i = 0; i < events.length; i += 1) {
        progressBar.update(i);
        try {
            const { event, transactionHash, returnValues } = events[i];
            if (event !== 'DelegateAdded') continue;
            const { idDelegate } = returnValues;
            const pledgeAdmin = await pledgeAdminModel.findOne({ id: Number(idDelegate) });
            if (pledgeAdmin) {
                continue;
            }
            const { from } = await getTransaction(
                {txHash:transactionHash, isHome:false, foreignWeb3, homeWeb3});
            const delegateId = idDelegate;
            let community = await communityModel.findOne({ txHash:transactionHash });
            if (!community) {
                const communityData = await getCommunityDataForCreate({
                    homeWeb3,
                    foreignWeb3,
                    liquidPledging,
                    from,
                    txHash: transactionHash,
                    delegateId,
                });
                community = await new communityModel(communityData).save();
                report.createdCommunities++;
                logger.info('created community ', community);
            }
            await new pledgeAdminModel(
                { id: Number(delegateId), type: 'community', typeId: community._id, isRecovered :true }).save();
            report.createdPledgeAdmins++;

        } catch (e) {
            logger.error('error in creating community', e);
        }
    }
    progressBar.update(events.length);
    progressBar.stop();
    const spentTime = (new Date().getTime() - startTime.getTime()) / 1000;
    report.syncDelegatesSpentTime = spentTime;
    console.log(`community/delegate events synced end.\n spentTime :${spentTime} seconds`);
};
