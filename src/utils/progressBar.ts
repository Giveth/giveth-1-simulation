const  cliProgress = require("cli-progress");
import * as _colors from "colors";

export const createProgressBar = (options :{ title:string }) => {
    const {title} = options;
    return new cliProgress.SingleBar({
        format: `${title} |${_colors.cyan(
            '{bar}',
        )}| {percentage}% || {value}/{total}`,
        barCompleteChar: '\u2588',
        barIncompleteChar: '\u2591',
        hideCursor: true,
    });
};
