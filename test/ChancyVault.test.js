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

  it("accepts USDC deposits into the vault and emits auditable credit events", async function () {
    const { player, usdc, vault } = await deployVaultFixture();

    await expect(vault.connect(player).deposit(USDC(25)))
      .to.emit(vault, "Deposited")
      .withArgs(player.address, USDC(25));

    expect(await usdc.balanceOf(await vault.getAddress())).to.equal(USDC(25));
    expect(await vault.totalDeposited()).to.equal(USDC(25));
  });

  it("allows only controller to sweep surplus funds to cold wallet", async function () {
    const { controller, coldWallet, player, other, usdc, vault } = await deployVaultFixture();
    await vault.connect(player).deposit(USDC(100));

    await expect(vault.connect(other).sweepToCold(USDC(80))).to.be.revertedWithCustomError(vault, "OwnableUnauthorizedAccount");

    await expect(vault.connect(controller).sweepToCold(USDC(80)))
      .to.emit(vault, "SweptToCold")
      .withArgs(coldWallet.address, USDC(80));

    expect(await usdc.balanceOf(coldWallet.address)).to.equal(USDC(80));
    expect(await usdc.balanceOf(await vault.getAddress())).to.equal(USDC(20));
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
