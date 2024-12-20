import fs from 'fs';
import path from 'path';

// Logger class
class Logger {
    private logFile: string;

    constructor(logFileName: string) {
        this.logFile = path.join(__dirname, logFileName);
    }

    log(message: string): void {
        const timestamp = new Date().toISOString();
        const logMessage = `[${timestamp}] LOG: ${message}\n`;
        fs.appendFileSync(this.logFile, logMessage);
    }

    error(message: string): void {
        const timestamp = new Date().toISOString();
        const errorMessage = `[${timestamp}] ERROR: ${message}\n`;
        fs.appendFileSync(this.logFile, errorMessage);
    }
}

// Instantiate a logger
const logger = new Logger('sol-swap.log');

// Save original console.log and console.error functions
const originalConsoleLog = console.log;
const originalConsoleError = console.error;

// Helper function to serialize arguments
const serializeArgs = (args: unknown[]): string =>
    args
        .map(arg =>
            typeof arg === 'bigint'
                ? `${arg.toString()}n` // Handle BigInt specifically
                : typeof arg === 'object'
                ? JSON.stringify(arg, (_, value) => (typeof value === 'bigint' ? value.toString() : value)) // Replace BigInt in objects
                : arg
        )
        .join(' ');

// Override console.log
console.log = (...args: unknown[]): void => {
    const message = serializeArgs(args);
    logger.log(message);
    originalConsoleLog.apply(console, args);
};

// Override console.error
console.error = (...args: unknown[]): void => {
    const message = serializeArgs(args);
    logger.error(message);
    originalConsoleError.apply(console, args);
};

// Export the logger if needed directly
export { logger };
