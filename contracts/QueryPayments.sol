// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

contract QueryPayments {
    address public owner;
    address public treasury;
    uint256 public price;
    mapping(bytes32 => bool) public queryIdUsed;

    event QueryPaid(bytes32 indexed queryId, address indexed payer, uint256 amount);
    event PriceUpdated(uint256 oldPrice, uint256 newPrice);
    event TreasuryUpdated(address oldTreasury, address newTreasury);
    event OwnershipTransferred(address indexed oldOwner, address indexed newOwner);

    constructor(address _treasury, uint256 _price) {
        require(_treasury != address(0), "Zero address");
        require(_price > 0, "Price must be > 0");

        owner = msg.sender;
        treasury = _treasury;
        price = _price;
    }

    function pay(bytes32 queryId) external payable {
        require(msg.value == price, "Wrong payment amount");
        require(!queryIdUsed[queryId], "QueryId already used");

        queryIdUsed[queryId] = true;

        (bool success, ) = treasury.call{value: msg.value}("");
        require(success, "Treasury transfer failed");

        emit QueryPaid(queryId, msg.sender, msg.value);
    }

    function setPrice(uint256 newPrice) external {
        require(msg.sender == owner, "Not owner");
        require(newPrice > 0, "Price must be > 0");

        emit PriceUpdated(price, newPrice);
        price = newPrice;
    }

    function setTreasury(address newTreasury) external {
        require(msg.sender == owner, "Not owner");
        require(newTreasury != address(0), "Zero address");

        emit TreasuryUpdated(treasury, newTreasury);
        treasury = newTreasury;
    }

    function transferOwnership(address newOwner) external {
        require(msg.sender == owner, "Not owner");
        require(newOwner != address(0), "Zero address");

        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }
}
