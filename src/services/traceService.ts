import {traceModel, TraceMongooseDocument, TraceStatus} from "../models/traces.model";
import {createProgressBar} from "../utils/progressBar";
import {EventInterface, ReportInterface} from "../utils/interfaces";
import {ZERO_ADDRESS} from "../utils/web3Helpers";
import {getLogger} from "../utils/logger";
const logger = getLogger();


const getExpectedStatus = (events: EventInterface[], trace: TraceMongooseDocument) => {
    const { maxAmount, donationCounters, fullyFunded, reviewerAddress } = trace;
    const hasReviewer = reviewerAddress && reviewerAddress !== ZERO_ADDRESS;

    const eventToStatus = {
        ApproveCompleted: TraceStatus.COMPLETED,
        CancelProject: TraceStatus.CANCELED,
        MilestoneCompleteRequestApproved: TraceStatus.COMPLETED,
        MilestoneCompleteRequestRejected: TraceStatus.IN_PROGRESS,
        MilestoneCompleteRequested: TraceStatus.NEEDS_REVIEW,
        // "PaymentCollected", // expected status depends on milestone
        ProjectAdded: TraceStatus.IN_PROGRESS,
        // "ProjectUpdated", // Does not affect milestone status
        // "RecipientChanged", // Does not affect milestone status
        RejectCompleted: TraceStatus.REJECTED,
        RequestReview: TraceStatus.NEEDS_REVIEW,
    };

    const lastEvent = events.pop();
    if (lastEvent.event === 'PaymentCollected') {
        if (
            (fullyFunded || hasReviewer) &&
          donationCounters[0] &&
          donationCounters[0].currentBalance.toString() === '0'
        ) {
            return TraceStatus.PAID;
        }
        return getExpectedStatus(events, trace);
    }
    return eventToStatus[lastEvent.event];
};

export const updateTracesFinalStatus = async (options :{
    report:ReportInterface,
    events: EventInterface[],

}) => {
    const {report, events} = options;
    const traces = await traceModel.find({ projectId: { $gt: 0 } });
    const startTime = new Date();
    const progressBar = createProgressBar({ title: 'Updating milestone status' });
    progressBar.start(traces.length);
    for (const milestone of traces) {
        progressBar.increment();
        const { status, projectId } = milestone;
        const matchedEvents = events.filter(event => event.returnValues && String(event.returnValues.idProject) === String(projectId));
        if ([TraceStatus.ARCHIVED, TraceStatus.CANCELED].includes(status)) continue;

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
            await traceModel.updateOne({ _id: milestone._id }, { status: expectedStatus, mined: true });
            // report.updatedTraceStatus ++;
        }
    }
    progressBar.update(traces.length);
    progressBar.stop();
    const spentTime = (new Date().getTime() - startTime.getTime()) / 1000;
    console.log(`Updating milestone status synced end.\n spentTime :${spentTime} seconds`);
    report.syncTraceSpentTime = spentTime;
};
