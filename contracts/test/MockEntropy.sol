// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import {IEntropyV2} from "@pythnetwork/entropy-sdk-solidity/IEntropyV2.sol";
import {IEntropyConsumer} from "@pythnetwork/entropy-sdk-solidity/IEntropyConsumer.sol";
import {EntropyStructsV2} from "@pythnetwork/entropy-sdk-solidity/EntropyStructsV2.sol";

contract MockEntropy is IEntropyV2 {
    address public defaultProvider;
    uint128 public fee;

    function setFee(uint128 fee_) external {
        fee = fee_;
    }

    mapping(address => EntropyStructsV2.ProviderInfo) public providers;
    mapping(address => mapping(uint64 => EntropyStructsV2.Request)) public requests;

    constructor(address defaultProvider_) {
        require(defaultProvider_ != address(0), "INVALID_PROVIDER");
        defaultProvider = defaultProvider_;
        providers[defaultProvider_].sequenceNumber = 1;
        providers[defaultProvider_].feeInWei = 0;
        providers[defaultProvider_].defaultGasLimit = 100000;
    }

    function requestV2() external payable returns (uint64 assignedSequenceNumber) {
        return _requestV2(defaultProvider, bytes32(0), 0);
    }

    function requestV2(uint32 gasLimit) external payable returns (uint64 assignedSequenceNumber) {
        return _requestV2(defaultProvider, bytes32(0), gasLimit);
    }

    function requestV2(address provider, uint32 gasLimit) external payable returns (uint64 assignedSequenceNumber) {
        return _requestV2(provider, bytes32(0), gasLimit);
    }

    function requestV2(
        address provider,
        bytes32 userRandomNumber,
        uint32 gasLimit
    ) external payable returns (uint64 assignedSequenceNumber) {
        return _requestV2(provider, userRandomNumber, gasLimit);
    }

    function _requestV2(
        address provider,
        bytes32 userRandomNumber,
        uint32 gasLimit
    ) internal returns (uint64 assignedSequenceNumber) {
        EntropyStructsV2.ProviderInfo storage providerInfo = providers[provider];
        if (providerInfo.sequenceNumber == 0) {
            providerInfo.sequenceNumber = 1;
            providerInfo.feeInWei = 0;
            providerInfo.defaultGasLimit = 100000;
        }

        assignedSequenceNumber = providerInfo.sequenceNumber;
        providerInfo.sequenceNumber += 1;

        uint32 effectiveGasLimit = gasLimit == 0 ? providerInfo.defaultGasLimit : gasLimit;
        EntropyStructsV2.Request storage req = requests[provider][assignedSequenceNumber];
        req.provider = provider;
        req.sequenceNumber = assignedSequenceNumber;
        req.requester = msg.sender;
        req.blockNumber = uint64(block.number);
        req.useBlockhash = false;
        req.gasLimit10k = uint16(effectiveGasLimit / 10000);

        emit Requested(provider, msg.sender, assignedSequenceNumber, userRandomNumber, effectiveGasLimit, bytes(""));
    }

    function mockReveal(address provider, uint64 sequenceNumber, bytes32 randomNumber) external {
        EntropyStructsV2.Request storage req = requests[provider][sequenceNumber];
        require(req.requester != address(0), "REQUEST_NOT_FOUND");
        address requester = req.requester;

        emit Revealed(
            provider,
            requester,
            sequenceNumber,
            randomNumber,
            bytes32(0),
            bytes32(0),
            false,
            bytes(""),
            0,
            bytes("")
        );

        delete requests[provider][sequenceNumber];
        IEntropyConsumer(requester)._entropyCallback(sequenceNumber, provider, randomNumber);
    }

    function getProviderInfoV2(address provider) external view returns (EntropyStructsV2.ProviderInfo memory) {
        return providers[provider];
    }

    function getDefaultProvider() external view returns (address provider) {
        return defaultProvider;
    }

    function getRequestV2(
        address provider,
        uint64 sequenceNumber
    ) external view returns (EntropyStructsV2.Request memory req) {
        return requests[provider][sequenceNumber];
    }

    function getFeeV2() external view returns (uint128 feeAmount) {
        return fee;
    }

    function getFeeV2(uint32) external view returns (uint128 feeAmount) {
        return fee;
    }

    function getFeeV2(address, uint32) external view returns (uint128 feeAmount) {
        return fee;
    }
}
