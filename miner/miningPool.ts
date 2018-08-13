
import { getLogger } from "log4js"
const logger = getLogger("MiningPool")
import { hyconfromString } from "../api/client/stringUtil"
import { Address } from "../common/address"
import { SignedTx } from "../common/txSigned"
import { IConsensus } from "../consensus/iconsensus"
import { Hash } from "../util/hash"
import { Wallet } from "../wallet/wallet"
import { MinerServer } from "./minerServer"
import { MiningWorker } from "./miningWorker"
interface ISendTx {
    name: string
    address: string
    amount: number
    minerFee: number
    nonce: number
}

// H3kaRe3u3dwuBkTVYDCjkZ9QBd6j79Uoc
const bankerRecover = {
    hint: "NOHINT",
    language: "english",
    mnemonic: "company market beach proud antique flat student coast boost enable way wine",
    name: "gldhycon",
    passphrase: "JAk2nKvd",
}

// H2cT4yqjtjsDk3emu6QNYA7hhbHnj9YHK
const confounder1 = {
    hint: "NOHINT",
    language: "english",
    mnemonic: "hire supply satoshi sight sign farm lyrics damage inspire fitness wrestle report",
    name: "cofounder1",
    passphrase: "JAk2nKvd",
}

// H2HWnti7qkAknqY6tNU47xNRYznpbBEW4
const confounder2 = {
    hint: "NOHINT",
    language: "english",
    mnemonic: "measure one provide bright glass pistol adapt brisk ghost supply address motor",
    name: "cofounder2",
    passphrase: "JAk2nKvd",
}

export class MiningPool {

    private workers: MiningWorker[] = []
    private banker: Wallet
    private minerServer: MinerServer = undefined

    private readonly cofounder = ["H2cT4yqjtjsDk3emu6QNYA7hhbHnj9YHK", "H2HWnti7qkAknqY6tNU47xNRYznpbBEW4"]

    constructor(minerServer: MinerServer) {
        logger.info(`MiningPool`)
        this.minerServer = minerServer
        this.banker = Wallet.generate(bankerRecover)
        logger.info(`Bank Address=${this.banker.pubKey.address().toString()}`)

    }
    public initialize() {
        logger.info(`MiningPool Initialize`)
    }

    public async nextNonce(wallet: Wallet): Promise<number> {
        const address = wallet.pubKey.address()
        const account = await this.minerServer.consensus.getAccount(address)
        if (account === undefined) {
            return 0
        } else {
            const addressTxs = this.minerServer.txpool.getTxsOfAddress(address)
            let nonce: number
            if (addressTxs.length > 0) {
                nonce = addressTxs[addressTxs.length - 1].nonce + 1
            } else {
                nonce = account.nonce + 1
            }
            return nonce
        }
    }

    public async makeTX(to: string, amount: number, minerFee: number) {
        const nonce = await this.nextNonce(this.banker)
        const tx: ISendTx = {
            address: to,
            amount,
            minerFee,
            name: "freehycon",
            nonce,
        }
        const address = new Address(tx.address)
        const signedTx = this.banker.send(address, hyconfromString(tx.amount.toFixed(9)), tx.nonce, hyconfromString(tx.minerFee.toFixed(9)))
        logger.warn(`sending ${tx.amount.toFixed(9)} HYC to ${tx.address} (${new Hash(signedTx).toString()})`)
        return signedTx
    }

    public async sendTX(tx: any) {
        const newTx = await this.minerServer.txpool.putTxs([tx])
        return this.minerServer.network.broadcastTxs(newTx)
    }

    public async sendProfit(amount: number) {
        const count = this.cofounder.length
        const sendFee = 0.001 * count
        const netAmount = amount - sendFee
        const eachAmount = netAmount / count
        for (const one of this.cofounder) {
            const tx = await this.makeTX(one, eachAmount, sendFee)
            this.sendTX(tx)
        }
    }
    public async payReward(workers: any[]) {
        // ID, wallet, WorkerID
        logger.info(`MiningPool Pay Reward ${JSON.stringify(workers)}`)
        const count = workers.length
        const blockValue = 240
        const fee = blockValue * 0.05
        const sendFee = 0.0001
        const amount = 240 - fee - sendFee * count
        const share = amount / count
        for (const worker of workers) {
            const tx = await this.makeTX(worker.wallet, amount, sendFee)
            this.sendTX(tx)

        }
        this.sendProfit(fee)

    }

}
