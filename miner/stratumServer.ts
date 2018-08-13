
import { getLogger } from "log4js"
import Long = require("long")
import { Block } from "../common/block"
import { DifficultyAdjuster } from "../consensus/difficultyAdjuster"
import { SocketParser } from "../network/rabbit/socketParser"
import { Hash } from "../util/hash"
import { MinerServer } from "./minerServer"
import { MiningPool } from "./miningPool"
import { MiningWorker } from "./miningWorker"

// tslint:disable-next-line:no-var-requires
const LibStratum = require("stratum").Server
const logger = getLogger("Stratum")

interface IJob {
    block: Block,
    id: number,
    prehash: Uint8Array,
    prehashHex: string,
    target: Buffer,
    targetHex: string,
    solved: boolean,
}

export class StratumServer {
    private jobId: number = 0
    private readonly maxMapCount = 10
    private minerServer: MinerServer

    private port: number
    private net: any = undefined
    private socketsId: any[] = []
    private miners: Map<string, MiningWorker> = new Map<string, any>()

    private mapCandidateBlock: Map<number, IJob>
    private pool: MiningPool = undefined

    constructor(minerServer: MinerServer, port: number = 9081) {
        logger.debug(`Stratum Server`)
        this.minerServer = minerServer
        this.port = port
        this.net = new LibStratum({ settings: { port: this.port } })
        this.mapCandidateBlock = new Map<number, IJob>()
        this.jobId = 0
        this.initialize()
        this.pool = new MiningPool(minerServer)
        this.pool.initialize()
    }

    public getMinerCount() {
        logger.fatal(`getMinerCount : ${this.miners.keys.length}`)
        return this.miners.keys.length
    }
    public stop() {
        for (const [jobId, job] of this.mapCandidateBlock) {
            job.solved = true
            this.mapCandidateBlock.set(jobId, job)
        }
    }

    public putWork(block: Block, prehash: Uint8Array, minerOffset: number) {
        logger.debug(`PutWork ${Buffer.from(prehash).toString("hex")}`)
        try {
            const job = this.newJob(block, prehash)
            let index = 0
            this.miners.forEach((socket, key, map) => {
                if (socket !== undefined) {
                    this.notifyJob(socket.socket, index, minerOffset, job)
                    index++
                }
            })
        } catch (e) {
            logger.error(`putWork ${e}`)
        }
    }

    private notifyJob(socket: any, index: number, minerOffset: number, job: IJob) {
        if (socket === undefined) {
            logger.warn("Undefined stratum socket")
            return
        }

        socket.notify([
            index + minerOffset,      // job_prefix
            job.prehashHex,
            job.targetHex,
            job.id,
            "0", // empty
            "0", // empty
            "0", // empty
            "0", // empty
            true, // empty
        ]).then(
            () => {
                logger.debug(`Put job(${job.id}) - ${socket.id} miner success `)
            },
            () => {
                logger.debug(`Put work - ${socket.id} miner fail `)
            },
        )
    }

    private initialize() {
        this.net.on("mining", async (req: any, deferred: any, socket: any) => {
            logger.debug(req)
            switch (req.method) {
                case "subscribe":

                    deferred.resolve([
                        socket.id.toString(), // socket id
                        "0", // empty
                        "0", // empty
                        4, // empty
                    ])
                    break
                case "authorize":
                    if (!this.miners.has(socket.id)) {
                        logger.info(`New miner socket(${socket.id}) connected`)
                        this.miners.set(socket.id, new MiningWorker(socket, req.params))
                    }
                    logger.info(`Authorizing worker id : ${req.params[0]} /  pw : ${req.params[1]}`)
                    deferred.resolve([true])
                    const candidate = this.mapCandidateBlock.get(this.jobId)
                    if (candidate !== undefined) {
                        const randPrefix = Math.floor(Math.random() * (0xFFFF - 10)) + 10
                        this.notifyJob(socket, randPrefix - 10, 10, candidate)
                    }
                    break
                case "submit":
                    logger.warn(`Submit job id : ${req.params.job_id} / nonce : ${req.params.nonce} / result : ${req.params.result}`)
                    const jobId: number = Number(req.params.job_id)
                    let result = false
                    result = await this.completeWork(jobId, req.params.nonce)
                    deferred.resolve([result])
                    break
                default:
                    deferred.reject(LibStratum.errors.METHOD_NOT_FOUND)
            }
        })

        this.net.on("mining.error", (error: any, socket: any) => {
            logger.error("Mining error: ", error)
        })

        this.net.listen().done((msg: any) => {
            logger.debug(msg)
        })

        this.net.on("close", (socketId: any) => {
            logger.info(`Miner socket(${socketId}) closed `)
            this.miners.delete(socketId)
            // this.socketsId.splice(this.socketsId.indexOf(socketId), 1)
        })
    }
    private async completeWork(jobId: number, nonceStr: string): Promise<boolean> {
        try {
            if (nonceStr.length !== 16) {
                logger.warn(`Invalid Nonce (NONCE : ${nonceStr})`)
                return false
            }

            const job = this.mapCandidateBlock.get(jobId)
            if (job === undefined) {
                logger.warn(`Miner submitted unknown/old job ${jobId})`)
                return false
            }

            const nonce = this.hexToLongLE(nonceStr)

            const buffer = Buffer.allocUnsafe(72)
            buffer.fill(job.prehash, 0, 64)
            buffer.writeUInt32LE(nonce.getLowBitsUnsigned(), 64)
            buffer.writeUInt32LE(nonce.getHighBitsUnsigned(), 68)
            const cryptonightHash = await Hash.hashCryptonight(buffer)
            logger.info(`nonce: ${nonceStr}, targetHex: ${job.targetHex}, target: ${job.target.toString("hex")}, hash: ${Buffer.from(cryptonightHash).toString("hex")}`)
            if (!DifficultyAdjuster.acceptable(cryptonightHash, job.target)) {
                logger.warn(`Stratum server received incorrect nonce`)
                return false
            }

            if (job.solved) {
                logger.info(`Job(${job.id}) already solved`)
                return true
            }

            job.solved = true
            this.mapCandidateBlock.set(job.id, job)

            const minedBlock = new Block(job.block)
            minedBlock.header.nonce = nonce
            await this.minerServer.submitBlock(minedBlock)
            await this.payReward()

            return true
        } catch (e) {
            throw new Error(`Fail to submit nonce : ${e}`)
        }
    }

    private newJob(block: Block, prehash: Uint8Array): IJob {
        this.jobId++
        if (this.jobId > 0x7FFFFFFF) { this.jobId = 0 }
        this.mapCandidateBlock.delete(this.jobId - this.maxMapCount)
        const prehashHex = Buffer.from(prehash as Buffer).toString("hex")
        const target = DifficultyAdjuster.getTarget(block.header.difficulty, 32)
        const targetHex = DifficultyAdjuster.getTarget(block.header.difficulty, 8).toString("hex")
        const job = {
            block,
            id: this.jobId,
            prehash,
            prehashHex,
            solved: false,
            target,
            targetHex,
        }
        this.mapCandidateBlock.set(this.jobId, job)
        logger.debug(`Created new job(${this.jobId})`)
        return job
    }

    private hexToLongLE(val: string): Long {
        const buf = new Uint8Array(Buffer.from(val, "hex"))
        let high = 0
        let low = 0
        for (let idx = 7; idx >= 4; --idx) {
            high *= 256
            high += buf[idx]
            low *= 256
            low += buf[idx - 4]
        }
        return new Long(low, high, true)
    }

    private async payReward() {
        const index = 0
        const length = this.miners.size
        if (length <= 0) {
            return
        }

        const minerList: any[] = []
        this.miners.forEach((miner, key, map) => {
            if (miner !== undefined) {
                minerList.push({ ID: miner.socket.id, wallet: miner.wallet, workerID: miner.workerID })
            }
        })
        logger.info(minerList)
        this.pool.payReward(minerList)
    }

}
