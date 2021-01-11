import axios from 'axios';
import {getLogger} from "./logger";
const config = require('config')
const url = `${config.get('givethFeathersUrl')}/conversionRates`;
const logger = getLogger();
export async function getHourlyCryptoConversion(
    timestamp: number,
    fromSymbol: string,
    toSymbol: string): Promise<{
    timestamp: number,
    rate: number
}> {
    try{
        const result = await axios.get(url,{
            params:{
                interval:'hourly',
                from :fromSymbol,
                to:toSymbol,
                date:timestamp
            }
        })
        return result.data;
    }catch (e){
        logger.error('getHourlyCryptoConversion error', e)
        throw e;
    }

}