import { Logger } from 'winston';

const BigNumber = require('bignumber.js');

import { getTokenByAddress } from './tokenUtility';
import { getLogger } from './logger';
import {getHourlyCryptoConversion} from "./giveth-feathers-service";
import {DonationMongooseDocument} from "../models/donations.model";

// Used by scripts to set usdValue of donations
export class DonationUsdValueUtility {
  services;
  logger;
  constructor(conversionRateModel, config, logger:Logger) {
    this.logger = logger;
  }

  async setDonationUsdValue(donation :DonationMongooseDocument) {
    const { createdAt, tokenAddress, amount } = donation;
    try {
      const token = getTokenByAddress(tokenAddress);
      const { symbol } = token;
      const { rate } = await getHourlyCryptoConversion(createdAt.getTime(), symbol, 'USD');
      const usdValue = Number(
        new BigNumber(amount.toString())
          .div(10 ** 18)
          .times(Number(rate))
          .toFixed(2),
      );
      donation.usdValue = usdValue;
    } catch (e) {
    }
  }
}

