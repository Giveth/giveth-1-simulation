import {getDacDataForCreate} from "../utils/createProjectHelper";
import {pledgeAdminModel} from "../models/pledgeAdmins.model";
import {getTransaction} from "../utils/web3Helpers";
import {dacModel} from "../models/dacs.model";
import {createProgressBar} from "../utils/progressBar";
import {EventInterface, ReportInterface} from "../utils/interfaces";
import {getLogger} from "../utils/logger";

const logger = getLogger();
export const syncDacs = async (options:{
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
    console.log('syncDacs called', { fixConflicts });
    if (!fixConflicts) return;
    const startTime = new Date();
    const progressBar = createProgressBar({ title: 'Syncing Dacs with events' });
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
            let dac = await dacModel.findOne({ txHash:transactionHash });
            if (!dac) {
                const dacData = await getDacDataForCreate({
                    homeWeb3,
                    foreignWeb3,
                    liquidPledging,
                    from,
                    txHash: transactionHash,
                    delegateId,
                });
                dac = await new dacModel(dacData).save();
                report.createdDacs++;
                logger.info('created dac ', dac);
            }
            await new pledgeAdminModel(
                { id: Number(delegateId), type: 'dac', typeId: dac._id, isRecovered :true }).save();
            report.createdPledgeAdmins++;

        } catch (e) {
            logger.error('error in creating dac', e);
        }
    }
    progressBar.update(events.length);
    progressBar.stop();
    const spentTime = (new Date().getTime() - startTime.getTime()) / 1000;
    report.syncDelegatesSpentTime = spentTime;
    console.log(`dac/delegate events synced end.\n spentTime :${spentTime} seconds`);
};
