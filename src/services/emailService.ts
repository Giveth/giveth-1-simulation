import axios from 'axios';
import { ReportInterface } from '../utils/interfaces';
const moment = require('moment');
const config = require('config');
const dappMailerUrl = config.get('dappMailerUrl')
const givethDevMailList = config.get('givethDevMailList')
const givethMaintainersEmail = config.get('givethMaintainersEmail')
const dappMailerSecret = config.get('dappMailerSecret')

export const sendReportEmail = async (reportData: ReportInterface) => {
  try {
    const tableStyle = 'width:100%; border: 1px solid black;  border-collapse: collapse;';
    const tableCellStyle = '  text-align: left;padding: 5px; border: 1px solid black;  border-collapse: collapse;';
    const promises = [];

    /**
     * You can see the dapp-mail code here @see{@link https://github.com/Giveth/dapp-mailer/blob/master/src/services/send/send.hooks.js}
     */
    const data : any = {
      template: 'notification',
      subject: `Simulation report ${moment().format('YYYY-MM-DD HH:m:s')} ${process.env.NODE_ENV}` ,
      image: 'Giveth-review-banner-email.png',
      text: `
              <table style='${tableStyle}'>
                <tr>
                  <td style='${tableCellStyle}'>syncDelegatesSpentTime</td>
                  <td style='${tableCellStyle}'>${reportData.syncDelegatesSpentTime} seconds</td>
                </tr>
                <tr>
                  <td style='${tableCellStyle}'>syncProjectsSpentTime</td>
                  <td style='${tableCellStyle}'>${reportData.syncProjectsSpentTime} seconds</td>
                </tr>
                <tr>
                  <td style='${tableCellStyle}'>syncDonationsSpentTime</td>
                  <td style='${tableCellStyle}'>${reportData.syncDonationsSpentTime} seconds</td>
                </tr>
                <tr>
                  <td style='${tableCellStyle}'>syncPledgeAdminsSpentTime</td>
                  <td style='${tableCellStyle}'>${reportData.syncPledgeAdminsSpentTime} seconds</td>
                </tr>
                <tr>
                  <td style='${tableCellStyle}'>syncTraceSpentTime</td>
                  <td style='${tableCellStyle}'>${reportData.syncTraceSpentTime} seconds</td>
                </tr>
                <tr>
                  <td style='${tableCellStyle}'>createdCommunities count</td>
                  <td style='${tableCellStyle}'>${reportData.createdCommunities}</td>
                </tr>
                <tr>
                  <td style='${tableCellStyle}'>createdCampaigns count</td>
                  <td style='${tableCellStyle}'>${reportData.createdCampaigns}</td>
                </tr>
                <tr>
                  <td style='${tableCellStyle}'>createdTraces count</td>
                  <td style='${tableCellStyle}'>${reportData.createdTraces}</td>
                </tr>
                <tr>
                  <td style='${tableCellStyle}'>createdDonations count</td>
                  <td style='${tableCellStyle}'>${reportData.createdDonations}</td>
                </tr>
                <tr>
                  <td style='${tableCellStyle}'>deletedDonations count</td>
                  <td style='${tableCellStyle}'>${reportData.deletedDonations}</td>
                </tr>
                <tr>
                  <td style='${tableCellStyle}'>updatedDonations count</td>
                  <td style='${tableCellStyle}'>${reportData.updatedDonations}</td>
                </tr>
                <tr>
                  <td style='${tableCellStyle}'>updatedDonationsParent count</td>
                  <td style='${tableCellStyle}'>${reportData.updatedDonationsParent}</td>
                </tr>
                <tr>
                  <td style='${tableCellStyle}'>updatedDonationsMined count</td>
                  <td style='${tableCellStyle}'>${reportData.updatedDonationsMined}</td>
                </tr>
                <tr>
                  <td style='${tableCellStyle}'>updateAmountRemaining count</td>
                  <td style='${tableCellStyle}'>${reportData.updateAmountRemaining}</td>
                </tr>
                <tr>
                  <td style='${tableCellStyle}'>correctFailedDonations count</td>
                  <td style='${tableCellStyle}'>${reportData.correctFailedDonations}</td>
                </tr>
                <tr>
                  <td style='${tableCellStyle}'>createdPledgeAdmins count</td>
                  <td style='${tableCellStyle}'>${reportData.createdPledgeAdmins}</td>
                </tr>
                <tr>
                  <td style='${tableCellStyle}'>removedPendingAmountRemainingCount</td>
                  <td style='${tableCellStyle}'>${reportData.removedPendingAmountRemainingCount}</td>
                </tr>
                <tr>
                  <td style='${tableCellStyle}'>addedEventsToDb</td>
                  <td style='${tableCellStyle}'>${reportData.addedEventsToDb}</td>
                </tr>
              </table>
      `,
      // cta: `Manage Trace`,
      // ctaRelativeUrl: `/campaigns/${data.campaignId}/milestones/${data.traceId}`,
      unsubscribeType: 'simulation-report',
      unsubscribeReason: `You receive this email because you are in Giveth1-dev team`,
      // message: data.message,
    };
    const resolvedConflicts = Boolean(
      reportData.updatedDonationsMined ||
      reportData.updatedDonationsParent ||
      reportData.correctFailedDonations ||
      reportData.createdCampaigns ||
      reportData.createdCommunities ||
      reportData.createdDonations ||
      reportData.createdTraces ||
      reportData.createdPledgeAdmins ||
      reportData.updateAmountRemaining ||
      reportData.updatedDonations ||
      reportData.deletedDonations ||
      reportData.addedEventsToDb ||
      reportData.removedPendingAmountRemainingCount
    )
    const summaryMessage = resolvedConflicts ?
      'There were some conflicts that resolved' :
      "The DB was clean and simulation didn't fix any conflict" ;
    data.title = summaryMessage;
    data.secretIntro = summaryMessage;
    const emailList :string[]  = resolvedConflicts ? givethDevMailList : givethMaintainersEmail;
    emailList.forEach(recipient => {
      promises.push(
        axios.post(`${dappMailerUrl}/send`,{
          ...data, recipient
        },
          {
            headers:{
              Authorization:dappMailerSecret
            }
          }
          )
      )
    });
    await Promise.all(promises);
  } catch (e) {
    console.log('sendReportEmail error', e.message);
  }

};

export const sendSimulationErrorEmail = async (error: any,
                                      givethDevMailList:string[],
                                      dappMailerUrl :string,
                                      dappMailerSecret: string
                                      ) => {
  try {
    const promises = [];

    /**
     * You can see the dapp-mail code here @see{@link https://github.com/Giveth/dapp-mailer/blob/master/src/services/send/send.hooks.js}
     */
    const data = {
      template: 'notification',
      subject: `Simulation report ${new Date()}` ,
      secretIntro: `This is required but I dont know what is this field`,
      title: 'Simulation failed :((',
      image: 'Giveth-milestone-review-rejected-banner-email.png',
      text: error,
      unsubscribeType: 'simulation-report',
      unsubscribeReason: `You receive this email because you are in Giveth1-dev team`,
    };
    givethDevMailList.forEach(recipient => {
      promises.push(
        axios.post(`${dappMailerUrl}/send`,{
          ...data, recipient
        },
          {
            headers:{
              Authorization:dappMailerSecret
            }
          }
          )
      )
    });
    await Promise.all(promises);
  } catch (e) {
    console.log('sendSimulationErrorEmail error', e);
  }

};
