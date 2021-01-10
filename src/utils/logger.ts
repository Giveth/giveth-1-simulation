import * as DailyRotateFile from 'winston-daily-rotate-file';
import * as winston from 'winston';
import {Logger} from "winston";

const config = require('config')
let logger: Logger
export const getLogger = () => {
    if (logger){
        return logger;
    }
    const logDir = config.get('logDir') as string;
    const logLevel = config.get('logLevel') as string;
    const winstonTransports = [];
    if (logDir) {
        winstonTransports.push(
            new DailyRotateFile({
                dirname: logDir,
                filename: 'simulation-error-%DATE%.log',
                maxFiles: '30d',
            }),
        );
    } else {
        winstonTransports.push(new winston.transports.Console());
    }

    logger = winston.createLogger({
        level: logLevel,
        format: winston.format.simple(),
        transports: winstonTransports,
    });
    return logger;
}
