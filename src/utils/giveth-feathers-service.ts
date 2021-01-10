import axios from 'axios';
const url = 'https://feathers.develop.giveth.io/conversionRates';
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
        console.log('getHourlyCryptoConversion error', e)
        throw e;
    }

}