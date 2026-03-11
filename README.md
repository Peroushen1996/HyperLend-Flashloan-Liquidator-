# HyperLend Flashloan Liquidator ⚡

A production-deployed liquidation bot on **HyperEVM** that monitors undercollateralized debt positions on **HyperLend** and executes atomic flashloan liquidations — earning the liquidation bonus as profit with zero upfront capital required.

---

## 🧠 How It Works

HyperLend (an Aave-style lending protocol on HyperEVM) allows users to borrow assets against collateral. When a borrower's **health factor drops below 1.0**, their position becomes eligible for liquidation.

This bot exploits that opportunity atomically:

```
1. Off-chain bot (JS) monitors all borrower health factors via HyperLend's on-chain data
2. When a health factor < 1 is detected, the bot triggers the smart contract
3. Smart contract requests a flashloan for the debt amount (no upfront capital needed)
4. Contract repays the borrower's debt on HyperLend
5. Contract receives the borrower's collateral + liquidation bonus in return
6. Collateral is swapped back to repay the flashloan
7. Profit (liquidation bonus) is kept by the contract owner
```

All of steps 3–7 happen in a **single atomic transaction** — if anything fails, the entire transaction reverts with no loss.

---

## 🏗️ Architecture

```
HyperLend-Flashloan-Liquidator/
├── src/
│   └── Liquidator.sol        # Core liquidation smart contract
├── bot/
│   └── index.js              # Off-chain monitoring & execution bot
├── script/
│   └── DeployLiquidator.s.sol # Foundry deployment script
├── test/
│   └── Liquidator.t.sol      # Foundry unit tests
└── broadcast/                # On-chain deployment artifacts (HyperEVM)
```

### Smart Contract (`Liquidator.sol`)
- Implements the flashloan callback interface
- Calls HyperLend's `liquidationCall()` to seize collateral
- Handles repayment logic within a single transaction
- Owner-controlled with profit withdrawal functions

### Off-Chain Bot (`bot/index.js`)
- Polls HyperLend's protocol data provider for all active borrowers
- Calculates health factors in real-time
- Triggers the smart contract when a liquidatable position is found
- Built with ethers.js / viem

---

## 🚀 Deployment

**Network:** HyperEVM (Chain ID: 999)  
**Protocol:** HyperLend  
**Tooling:** Foundry

Deployment artifacts are available in `/broadcast/DeployLiquidator.s.sol/999/`

---

## 🛠️ Getting Started

### Prerequisites
- [Foundry](https://book.getfoundry.sh/getting-started/installation)
- Node.js v18+
- A funded wallet on HyperEVM

### Install Dependencies
```bash
git clone https://github.com/Peroushen1996/HyperLend-Flashloan-Liquidator-
cd HyperLend-Flashloan-Liquidator-
forge install
npm install
```

### Build
```bash
forge build
```

### Test
```bash
forge test -vvv
```

### Deploy
```bash
forge script script/DeployLiquidator.s.sol \
  --rpc-url <HYPEREVM_RPC_URL> \
  --account <KEYSTORE_ACCOUNT_NAME> \
  --broadcast
```

> 🔐 This project uses **Foundry's encrypted keystore** (`cast wallet import`) instead of passing raw private keys — keeping credentials off the command line and out of shell history.

### Run the Bot
```bash
cp .env.example .env
# Fill in your RPC URL, private key, and deployed contract address
node bot/index.js
```

---

## ⚙️ Environment Variables

```env
RPC_URL=<HyperEVM RPC endpoint>
LIQUIDATOR_CONTRACT=<Deployed contract address>
```

> ⚠️ Never commit your `.env` file. It is included in `.gitignore`. Private keys are managed securely via Foundry keystore (`cast wallet import`) and never stored in plain text.

---

## 🔐 Security Considerations

- The liquidation is **atomic** — either the full sequence executes or nothing does
- Only the contract owner can withdraw profits
- Flashloan repayment is enforced by the lending protocol itself — any shortfall causes a revert
- No user funds are held between transactions

---

## 📚 Tech Stack

| Layer | Technology |
|-------|-----------|
| Smart Contract | Solidity ^0.8.x |
| Development Framework | Foundry |
| Off-chain Bot | JavaScript (Node.js) |
| Network | HyperEVM (Chain ID 999) |
| Protocol | HyperLend (Aave V3 fork) |

---

## 📄 License

MIT
