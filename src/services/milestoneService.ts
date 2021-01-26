import {milestoneModel, MilestoneMongooseDocument, MilestoneStatus} from "../models/milestones.model";
import {createProgressBar} from "../utils/progressBar";
import {EventInterface, ReportInterface} from "../utils/interfaces";
import {ZERO_ADDRESS} from "../utils/web3Helpers";
import {getLogger} from "../utils/logger";
const logger = getLogger();


const getExpectedStatus = (events: EventInterface[], milestone: MilestoneMongooseDocument) => {
    const { maxAmount, donationCounters, fullyFunded, reviewerAddress } = milestone;
    const hasReviewer = reviewerAddress && reviewerAddress !== ZERO_ADDRESS;

    const eventToStatus = {
        ApproveCompleted: MilestoneStatus.COMPLETED,
        CancelProject: MilestoneStatus.CANCELED,
        MilestoneCompleteRequestApproved: MilestoneStatus.COMPLETED,
        MilestoneCompleteRequestRejected: MilestoneStatus.IN_PROGRESS,
        MilestoneCompleteRequested: MilestoneStatus.NEEDS_REVIEW,
        // "PaymentCollected", // expected status depends on milestone
        ProjectAdded: MilestoneStatus.IN_PROGRESS,
        // "ProjectUpdated", // Does not affect milestone status
        // "RecipientChanged", // Does not affect milestone status
        RejectCompleted: MilestoneStatus.REJECTED,
        RequestReview: MilestoneStatus.NEEDS_REVIEW,
    };

    const lastEvent = events.pop();
    if (lastEvent.event === 'PaymentCollected') {
        if (
            (fullyFunded || hasReviewer) &&
          donationCounters[0] &&
          donationCounters[0].currentBalance.toString() === '0'
        ) {
            return MilestoneStatus.PAID;
        }
        return getExpectedStatus(events, milestone);
    }
    return eventToStatus[lastEvent.event];
};

export const updateMilestonesFinalStatus = async (options :{
    report:ReportInterface,
    events: EventInterface[],

}) => {
    const {report, events} = options;
    const milestones = await milestoneModel.find({ projectId: { $gt: 0 } });
    const startTime = new Date();
    const progressBar = createProgressBar({ title: 'Updating milestone status' });
    progressBar.start(milestones.length);
    for (const milestone of milestones) {
        progressBar.increment();
        const { status, projectId } = milestone;
        const matchedEvents = events.filter(event => event.returnValues && String(event.returnValues.idProject) === String(projectId));
        if ([MilestoneStatus.ARCHIVED, MilestoneStatus.CANCELED].includes(status)) continue;

        let message = '';
        message += `Project ID: ${projectId}\n`;
        message += `Events: ${events.toString()}\n`;
        const expectedStatus = getExpectedStatus(matchedEvents, milestone);
        if (expectedStatus && status !== expectedStatus ){
            logger.error("should update milestone status",{
                 _id:milestone._id,
                status,
                expectedStatus
            })
            await milestoneModel.updateOne({ _id: milestone._id }, { status: expectedStatus, mined: true });
            // report.updatedMilestoneStatus ++;
        }
    }
    progressBar.update(milestones.length);
    progressBar.stop();
    const spentTime = (new Date().getTime() - startTime.getTime()) / 1000;
    console.log(`Updating milestone status synced end.\n spentTime :${spentTime} seconds`);
    report.syncMilestoneSpentTime = spentTime;
};
