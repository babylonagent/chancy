const { expect } = require("chai");
const { ethers } = require("hardhat");

const USDC = (n) => ethers.parseUnits(String(n), 6);
const ZERO = ethers.ZeroAddress;

async function deployVaultFixture() {
  const [deployer, controller, hotWallet, coldWallet, player, other] = await ethers.getSigners();
  const MockUSDC = await ethers.getContractFactory("MockUSDC");
  const usdc = await MockUSDC.deploy();
  const ChancyVault = await ethers.getContractFactory("ChancyVault");
  const vault = await ChancyVault.deploy(await usdc.getAddress(), controller.address, hotWallet.address, coldWallet.address);
  await usdc.mint(player.address, USDC(1000));
  await usdc.connect(player).approve(await vault.getAddress(), USDC(1000));
  return { deployer, controller, hotWallet, coldWallet, player, other, usdc, vault };
}

describe("ChancyVault V2 custody", function () {
  it("keeps controller, hot wallet, and cold wallet separate at deployment", async function () {
    const { controller, hotWallet, coldWallet, usdc, vault } = await deployVaultFixture();

    expect(await vault.owner()).to.equal(controller.address);
    expect(await vault.hotWallet()).to.equal(hotWallet.address);
    expect(await vault.coldWallet()).to.equal(coldWallet.address);
    expect(await vault.usdc()).to.equal(await usdc.getAddress());
    expect(controller.address).to.not.equal(hotWallet.address);
    expect(controller.address).to.not.equal(coldWallet.address);
    expect(hotWallet.address).to.not.equal(coldWallet.address);
  });

  it("accepts USDC deposits, sends 5% to controller, and emits net credit events", async function () {
    const { controller, player, usdc, vault } = await deployVaultFixture();

    await expect(vault.connect(player).deposit(USDC(100)))
      .to.emit(vault, "Deposited")
      .withArgs(player.address, USDC(100), USDC(95), USDC(5));

    expect(await usdc.balanceOf(await vault.getAddress())).to.equal(USDC(95));
    expect(await usdc.balanceOf(controller.address)).to.equal(USDC(5));
    expect(await vault.totalDeposited()).to.equal(USDC(100));
    expect(await vault.totalCredited()).to.equal(USDC(95));
    expect(await vault.totalFeesCollected()).to.equal(USDC(5));
  });

  it("hard-caps deposit fee at 5%", async function () {
    const { vault } = await deployVaultFixture();

    expect(await vault.depositFeeBps()).to.equal(500);
    expect(await vault.MAX_DEPOSIT_FEE_BPS()).to.equal(500);
  });

  it("allows only controller to sweep surplus funds to cold wallet", async function () {
    const { controller, coldWallet, player, other, usdc, vault } = await deployVaultFixture();
    await vault.connect(player).deposit(USDC(100));

    await expect(vault.connect(other).sweepToCold(USDC(80))).to.be.revertedWithCustomError(vault, "OwnableUnauthorizedAccount");

    await expect(vault.connect(controller).sweepToCold(USDC(80)))
      .to.emit(vault, "SweptToCold")
      .withArgs(coldWallet.address, USDC(80));

    expect(await usdc.balanceOf(coldWallet.address)).to.equal(USDC(80));
    expect(await usdc.balanceOf(await vault.getAddress())).to.equal(USDC(15));
  });

  it("lets controller update hot and cold wallets but rejects zero or duplicate role addresses", async function () {
    const { controller, hotWallet, coldWallet, other, vault } = await deployVaultFixture();

    await expect(vault.connect(controller).setHotWallet(coldWallet.address)).to.be.revertedWith("DUPLICATE_ROLE");
    await expect(vault.connect(controller).setColdWallet(hotWallet.address)).to.be.revertedWith("DUPLICATE_ROLE");
    await expect(vault.connect(controller).setHotWallet(ZERO)).to.be.revertedWith("INVALID_HOT_WALLET");

    await expect(vault.connect(controller).setHotWallet(other.address))
      .to.emit(vault, "HotWalletUpdated")
      .withArgs(hotWallet.address, other.address);
    expect(await vault.hotWallet()).to.equal(other.address);
  });
});
