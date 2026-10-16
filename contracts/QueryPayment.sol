// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract QueryPayment {
    error ZeroAddress();
    error ZeroFee();
    error InsufficientAllowance();
    error WithdrawFailed();
    error NotOwner();
    error ZeroAmount();
    error NoPendingOwner();
    error DelayNotMet();
    error NotAContract();

    event QueryPaid(address indexed user, uint256 fee, uint256 userQueryCount);
    event QueryFeeUpdated(uint256 oldFee, uint256 newFee);
    event QueryFeeQueued(uint256 pendingFee, uint256 activeAt);
    event Subscribed(address indexed user, uint256 expiry, uint256 fee);
    event SubscriptionFeeUpdated(uint256 oldFee, uint256 newFee);
    event SubscriptionFeeQueued(uint256 pendingFee, uint256 activeAt);
    event Withdrawn(address indexed to, uint256 amount);
    event OwnershipTransferred(address indexed oldOwner, address indexed newOwner);
    event OwnershipTransferStarted(address indexed currentOwner, address indexed pendingOwner);

    address public immutable usdcToken;
    uint256 public queryFee;
    uint256 public subscriptionFee;
    address public owner;
    address public pendingOwner;
    uint256 public totalQueriesPaid;
    uint256 public totalSubscriptions;
    uint256 public constant FEE_CHANGE_DELAY = 48 hours;
    uint256 public pendingQueryFee;
    uint256 public pendingQueryFeeActiveAt;
    uint256 public pendingSubscriptionFee;
    uint256 public pendingSubscriptionFeeActiveAt;
    mapping(address => uint256) public queriesByUser;
    mapping(address => uint256) public subscriptionExpiry;

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(
        address usdcToken_,
        address initialOwner,
        uint256 initialFeeAmount,
        uint256 initialSubscriptionFee
    ) {
        if (usdcToken_ == address(0) || initialOwner == address(0)) revert ZeroAddress();
        if (usdcToken_.code.length == 0) revert NotAContract();
        if (initialFeeAmount == 0 || initialSubscriptionFee == 0) revert ZeroFee();

        usdcToken = usdcToken_;
        owner = initialOwner;
        queryFee = initialFeeAmount;
        subscriptionFee = initialSubscriptionFee;

        emit OwnershipTransferred(address(0), initialOwner);
        emit QueryFeeUpdated(0, initialFeeAmount);
    }

    function payForQuery() external {
        uint256 fee = queryFee;

        if (IERC20(usdcToken).allowance(msg.sender, address(this)) < fee) {
            revert InsufficientAllowance();
        }

        bool success = IERC20(usdcToken).transferFrom(msg.sender, address(this), fee);
        if (!success) revert WithdrawFailed();

        uint256 updatedUserCount = queriesByUser[msg.sender] + 1;
        queriesByUser[msg.sender] = updatedUserCount;
        totalQueriesPaid += 1;

        emit QueryPaid(msg.sender, fee, updatedUserCount);
    }

    function subscribe() external {
        uint256 fee = subscriptionFee;

        if (IERC20(usdcToken).allowance(msg.sender, address(this)) < fee) {
            revert InsufficientAllowance();
        }

        bool success = IERC20(usdcToken).transferFrom(msg.sender, address(this), fee);
        if (!success) revert WithdrawFailed();

        uint256 currentExpiry = subscriptionExpiry[msg.sender];
        uint256 updatedExpiry = currentExpiry > block.timestamp ? currentExpiry + 30 days : block.timestamp + 30 days;
        subscriptionExpiry[msg.sender] = updatedExpiry;

        totalSubscriptions += 1;

        emit Subscribed(msg.sender, updatedExpiry, fee);
    }

    function isSubscribed(address user) external view returns (bool) {
        return subscriptionExpiry[user] > block.timestamp;
    }

    function setQueryFee(uint256 newFee) external onlyOwner {
        if (newFee == 0) revert ZeroFee();

        pendingQueryFee = newFee;
        pendingQueryFeeActiveAt = block.timestamp + FEE_CHANGE_DELAY;

        emit QueryFeeQueued(pendingQueryFee, pendingQueryFeeActiveAt);
    }

    function applyQueryFee() external {
        if (block.timestamp < pendingQueryFeeActiveAt) revert DelayNotMet();
        if (pendingQueryFee == 0) revert ZeroFee();

        uint256 oldFee = queryFee;
        queryFee = pendingQueryFee;
        pendingQueryFee = 0;
        pendingQueryFeeActiveAt = 0;

        emit QueryFeeUpdated(oldFee, queryFee);
    }

    function setSubscriptionFee(uint256 newFee) external onlyOwner {
        if (newFee == 0) revert ZeroFee();

        pendingSubscriptionFee = newFee;
        pendingSubscriptionFeeActiveAt = block.timestamp + FEE_CHANGE_DELAY;

        emit SubscriptionFeeQueued(pendingSubscriptionFee, pendingSubscriptionFeeActiveAt);
    }

    function applySubscriptionFee() external {
        if (block.timestamp < pendingSubscriptionFeeActiveAt) revert DelayNotMet();
        if (pendingSubscriptionFee == 0) revert ZeroFee();

        uint256 oldFee = subscriptionFee;
        subscriptionFee = pendingSubscriptionFee;
        pendingSubscriptionFee = 0;
        pendingSubscriptionFeeActiveAt = 0;

        emit SubscriptionFeeUpdated(oldFee, subscriptionFee);
    }

    function withdraw(address to, uint256 amount) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();

        bool success = IERC20(usdcToken).transfer(to, amount);
        if (!success) revert WithdrawFailed();

        emit Withdrawn(to, amount);
    }

    function withdrawAll(address to) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();

        uint256 balance = IERC20(usdcToken).balanceOf(address(this));
        if (balance == 0) revert ZeroAmount();

        bool success = IERC20(usdcToken).transfer(to, balance);
        if (!success) revert WithdrawFailed();

        emit Withdrawn(to, balance);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();

        pendingOwner = newOwner;

        emit OwnershipTransferStarted(owner, pendingOwner);
    }

    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert NoPendingOwner();

        address oldOwner = owner;
        owner = pendingOwner;

        emit OwnershipTransferred(oldOwner, owner);

        pendingOwner = address(0);
    }
}
