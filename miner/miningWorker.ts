import { getLogger } from "log4js"
const logger = getLogger("MiningWorker")
export class MiningWorker {
    public socket: any = undefined
    public wallet: string
    public workerID: string
    constructor(socket: any, params: any) {
        this.wallet = params[0]
        this.workerID = params[1]
        this.socket = socket
        logger.info(`Miner Wallet=${this.wallet}  WorkerID=${this.workerID}  Socket=${socket.id}`)
    }
}
