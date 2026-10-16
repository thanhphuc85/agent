// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {QueryPayment} from "../QueryPayment.sol";
import {MockERC20} from "../test-helpers/MockERC20.sol";

contract QueryPaymentTest is Test {
    // ------------------------------------------------------------------ state
    QueryPayment internal qp;
    MockERC20 internal usdc;

    address internal owner  = makeAddr("owner");
    address internal alice  = makeAddr("alice");
    address internal bob    = makeAddr("bob");

    uint256 internal constant INIT_QUERY_FEE = 1e6;          // 1 USDC
    uint256 internal constant INIT_SUB_FEE   = 10e6;         // 10 USDC
    uint256 internal constant SEED            = 1_000_000e6; // 1 M USDC

    // ------------------------------------------------------------------ setUp
    function setUp() public {
        // Deploy a fresh mock USDC and QueryPayment before every test.
        usdc = new MockERC20("Mock USDC", "mUSDC", 6);
        vm.prank(owner);
        qp = new QueryPayment(address(usdc), owner, INIT_QUERY_FEE, INIT_SUB_FEE);

        // Seed alice & bob with plenty of USDC and max allowance.
        usdc.mint(alice, SEED);
        usdc.mint(bob,   SEED);
        vm.prank(alice);
        usdc.approve(address(qp), type(uint256).max);
        vm.prank(bob);
        usdc.approve(address(qp), type(uint256).max);
    }

    // ================================================================
    // 1. DEPLOYMENT / INITIALISATION
    // ================================================================

    function test_Constructor_SetsStateCorrectly() public view {
        assertEq(qp.owner(),           owner);
        assertEq(qp.usdcToken(),       address(usdc));
        assertEq(qp.queryFee(),        INIT_QUERY_FEE);
        assertEq(qp.subscriptionFee(), INIT_SUB_FEE);
        assertEq(qp.totalQueriesPaid(), 0);
        assertEq(qp.totalSubscriptions(), 0);
        assertEq(qp.pendingOwner(),    address(0));
    }

    function test_Constructor_EmitsOwnershipTransferred() public {
        MockERC20 u2 = new MockERC20("u", "u", 6);
        vm.expectEmit(true, true, false, false);
        emit QueryPayment.OwnershipTransferred(address(0), owner);
        new QueryPayment(address(u2), owner, INIT_QUERY_FEE, INIT_SUB_FEE);
    }

    function test_Constructor_EmitsQueryFeeUpdated() public {
        MockERC20 u2 = new MockERC20("u", "u", 6);
        vm.expectEmit(false, false, false, true);
        emit QueryPayment.QueryFeeUpdated(0, INIT_QUERY_FEE);
        new QueryPayment(address(u2), owner, INIT_QUERY_FEE, INIT_SUB_FEE);
    }

    // ================================================================
    // 2. CONSTRUCTOR REVERT PATHS
    // ================================================================

    function test_Constructor_RevertZeroAddress_Token() public {
        vm.expectRevert(QueryPayment.ZeroAddress.selector);
        new QueryPayment(address(0), owner, INIT_QUERY_FEE, INIT_SUB_FEE);
    }

    function test_Constructor_RevertZeroAddress_Owner() public {
        MockERC20 u2 = new MockERC20("u", "u", 6);
        vm.expectRevert(QueryPayment.ZeroAddress.selector);
        new QueryPayment(address(u2), address(0), INIT_QUERY_FEE, INIT_SUB_FEE);
    }

    function test_Constructor_RevertZeroFee_QueryFee() public {
        MockERC20 u2 = new MockERC20("u", "u", 6);
        vm.expectRevert(QueryPayment.ZeroFee.selector);
        new QueryPayment(address(u2), owner, 0, INIT_SUB_FEE);
    }

    function test_Constructor_RevertZeroFee_SubFee() public {
        MockERC20 u2 = new MockERC20("u", "u", 6);
        vm.expectRevert(QueryPayment.ZeroFee.selector);
        new QueryPayment(address(u2), owner, INIT_QUERY_FEE, 0);
    }

    // ================================================================
    // 3. payForQuery — happy path
    // ================================================================

    function test_PayForQuery_TransfersUSDC() public {
        uint256 aliceBefore = usdc.balanceOf(alice);
        uint256 contractBefore = usdc.balanceOf(address(qp));

        vm.prank(alice);
        qp.payForQuery();

        assertEq(usdc.balanceOf(alice),      aliceBefore - INIT_QUERY_FEE);
        assertEq(usdc.balanceOf(address(qp)), contractBefore + INIT_QUERY_FEE);
    }

    function test_PayForQuery_IncrementsCounters() public {
        vm.prank(alice);
        qp.payForQuery();

        assertEq(qp.queriesByUser(alice),  1);
        assertEq(qp.totalQueriesPaid(),    1);

        vm.prank(alice);
        qp.payForQuery();

        assertEq(qp.queriesByUser(alice),  2);
        assertEq(qp.totalQueriesPaid(),    2);
    }

    function test_PayForQuery_EmitsQueryPaid() public {
        vm.prank(alice);
        vm.expectEmit(true, false, false, true, address(qp));
        emit QueryPayment.QueryPaid(alice, INIT_QUERY_FEE, 1);
        qp.payForQuery();
    }

    function test_PayForQuery_CounterPerUser() public {
        vm.prank(alice);
        qp.payForQuery();
        vm.prank(bob);
        qp.payForQuery();

        assertEq(qp.queriesByUser(alice), 1);
        assertEq(qp.queriesByUser(bob),   1);
        assertEq(qp.totalQueriesPaid(),   2);
    }

    // ================================================================
    // 4. payForQuery — revert paths
    // ================================================================

    function test_PayForQuery_RevertInsufficientAllowance() public {
        // Reset alice's allowance to zero.
        vm.prank(alice);
        usdc.approve(address(qp), 0);

        vm.prank(alice);
        vm.expectRevert(QueryPayment.InsufficientAllowance.selector);
        qp.payForQuery();
    }

    function test_PayForQuery_RevertInsufficientAllowance_PartialApproval() public {
        vm.prank(alice);
        usdc.approve(address(qp), INIT_QUERY_FEE - 1);

        vm.prank(alice);
        vm.expectRevert(QueryPayment.InsufficientAllowance.selector);
        qp.payForQuery();
    }

    function test_PayForQuery_RevertWithdrawFailed_TransferFails() public {
        usdc.setFailTransfers(true);

        vm.prank(alice);
        vm.expectRevert(QueryPayment.WithdrawFailed.selector);
        qp.payForQuery();
    }

    // ================================================================
    // 5. subscribe — happy path
    // ================================================================

    function test_Subscribe_TransfersUSDC() public {
        uint256 aliceBefore = usdc.balanceOf(alice);

        vm.prank(alice);
        qp.subscribe();

        assertEq(usdc.balanceOf(alice), aliceBefore - INIT_SUB_FEE);
        assertEq(usdc.balanceOf(address(qp)), INIT_SUB_FEE);
    }

    function test_Subscribe_SetsExpiry_NewSubscription() public {
        uint256 before = block.timestamp;

        vm.prank(alice);
        qp.subscribe();

        uint256 expiry = qp.subscriptionExpiry(alice);
        assertEq(expiry, before + 30 days);
    }

    function test_Subscribe_StacksExpiry_WhenAlreadyActive() public {
        vm.prank(alice);
        qp.subscribe();

        uint256 firstExpiry = qp.subscriptionExpiry(alice);

        vm.prank(alice);
        qp.subscribe();

        uint256 secondExpiry = qp.subscriptionExpiry(alice);
        // Should be exactly 30 days added on top of the first expiry.
        assertEq(secondExpiry, firstExpiry + 30 days);
    }

    function test_Subscribe_StacksExpiry_MultipleTopUps() public {
        vm.prank(alice);
        qp.subscribe();
        uint256 e1 = qp.subscriptionExpiry(alice);

        vm.prank(alice);
        qp.subscribe();
        uint256 e2 = qp.subscriptionExpiry(alice);
        assertEq(e2, e1 + 30 days);

        vm.prank(alice);
        qp.subscribe();
        uint256 e3 = qp.subscriptionExpiry(alice);
        assertEq(e3, e2 + 30 days);
    }

    function test_Subscribe_IncrementsCounter() public {
        vm.prank(alice);
        qp.subscribe();
        assertEq(qp.totalSubscriptions(), 1);

        vm.prank(bob);
        qp.subscribe();
        assertEq(qp.totalSubscriptions(), 2);
    }

    function test_Subscribe_EmitsSubscribed() public {
        uint256 expectedExpiry = block.timestamp + 30 days;

        vm.prank(alice);
        vm.expectEmit(true, false, false, true, address(qp));
        emit QueryPayment.Subscribed(alice, expectedExpiry, INIT_SUB_FEE);
        qp.subscribe();
    }

    function test_Subscribe_AfterExpiry_StartsFromNow() public {
        vm.prank(alice);
        qp.subscribe();

        // Warp 60 days past expiry so sub is fully expired.
        vm.warp(block.timestamp + 90 days);

        uint256 newStart = block.timestamp;
        vm.prank(alice);
        qp.subscribe();

        assertEq(qp.subscriptionExpiry(alice), newStart + 30 days);
    }

    // ================================================================
    // 6. subscribe — revert paths
    // ================================================================

    function test_Subscribe_RevertInsufficientAllowance() public {
        vm.prank(alice);
        usdc.approve(address(qp), 0);

        vm.prank(alice);
        vm.expectRevert(QueryPayment.InsufficientAllowance.selector);
        qp.subscribe();
    }

    function test_Subscribe_RevertWithdrawFailed_TransferFails() public {
        usdc.setFailTransfers(true);

        vm.prank(alice);
        vm.expectRevert(QueryPayment.WithdrawFailed.selector);
        qp.subscribe();
    }

    // ================================================================
    // 7. isSubscribed
    // ================================================================

    function test_IsSubscribed_FalseBeforeSubscribe() public view {
        assertFalse(qp.isSubscribed(alice));
    }

    function test_IsSubscribed_TrueAfterSubscribe() public {
        vm.prank(alice);
        qp.subscribe();
        assertTrue(qp.isSubscribed(alice));
    }

    function test_IsSubscribed_FalseAfterExpiry() public {
        vm.prank(alice);
        qp.subscribe();

        vm.warp(qp.subscriptionExpiry(alice) + 1);
        assertFalse(qp.isSubscribed(alice));
    }

    function test_IsSubscribed_TrueRightBeforeExpiry() public {
        vm.prank(alice);
        qp.subscribe();

        vm.warp(qp.subscriptionExpiry(alice) - 1);
        assertTrue(qp.isSubscribed(alice));
    }

    // ================================================================
    // 8. withdraw — happy path
    // ================================================================

    function test_Withdraw_TransfersTokens() public {
        // Fund contract via alice paying for a query.
        vm.prank(alice);
        qp.payForQuery();

        uint256 ownerBefore = usdc.balanceOf(owner);

        vm.prank(owner);
        qp.withdraw(owner, INIT_QUERY_FEE);

        assertEq(usdc.balanceOf(owner), ownerBefore + INIT_QUERY_FEE);
        assertEq(usdc.balanceOf(address(qp)), 0);
    }

    function test_Withdraw_EmitsWithdrawn() public {
        vm.prank(alice);
        qp.payForQuery();

        vm.prank(owner);
        vm.expectEmit(true, false, false, true, address(qp));
        emit QueryPayment.Withdrawn(owner, INIT_QUERY_FEE);
        qp.withdraw(owner, INIT_QUERY_FEE);
    }

    // ================================================================
    // 9. withdraw — revert paths
    // ================================================================

    function test_Withdraw_RevertNotOwner() public {
        vm.prank(alice);
        vm.expectRevert(QueryPayment.NotOwner.selector);
        qp.withdraw(alice, 1);
    }

    function test_Withdraw_RevertZeroAddress() public {
        vm.prank(owner);
        vm.expectRevert(QueryPayment.ZeroAddress.selector);
        qp.withdraw(address(0), 1);
    }

    function test_Withdraw_RevertZeroAmount() public {
        vm.prank(owner);
        vm.expectRevert(QueryPayment.ZeroAmount.selector);
        qp.withdraw(owner, 0);
    }

    function test_Withdraw_RevertWithdrawFailed_TransferFails() public {
        vm.prank(alice);
        qp.payForQuery();

        usdc.setFailTransfers(true);

        vm.prank(owner);
        vm.expectRevert(QueryPayment.WithdrawFailed.selector);
        qp.withdraw(owner, INIT_QUERY_FEE);
    }

    // ================================================================
    // 10. withdrawAll — happy path
    // ================================================================

    function test_WithdrawAll_TransfersEntireBalance() public {
        vm.prank(alice);
        qp.subscribe();
        vm.prank(bob);
        qp.payForQuery();

        uint256 expected = INIT_SUB_FEE + INIT_QUERY_FEE;
        uint256 ownerBefore = usdc.balanceOf(owner);

        vm.prank(owner);
        qp.withdrawAll(owner);

        assertEq(usdc.balanceOf(owner), ownerBefore + expected);
        assertEq(usdc.balanceOf(address(qp)), 0);
    }

    function test_WithdrawAll_EmitsWithdrawn() public {
        vm.prank(alice);
        qp.payForQuery();

        vm.prank(owner);
        vm.expectEmit(true, false, false, true, address(qp));
        emit QueryPayment.Withdrawn(owner, INIT_QUERY_FEE);
        qp.withdrawAll(owner);
    }

    // ================================================================
    // 11. withdrawAll — revert paths
    // ================================================================

    function test_WithdrawAll_RevertNotOwner() public {
        vm.prank(alice);
        vm.expectRevert(QueryPayment.NotOwner.selector);
        qp.withdrawAll(alice);
    }

    function test_WithdrawAll_RevertZeroAddress() public {
        vm.prank(alice);
        qp.payForQuery();

        vm.prank(owner);
        vm.expectRevert(QueryPayment.ZeroAddress.selector);
        qp.withdrawAll(address(0));
    }

    function test_WithdrawAll_RevertZeroAmount_EmptyBalance() public {
        vm.prank(owner);
        vm.expectRevert(QueryPayment.ZeroAmount.selector);
        qp.withdrawAll(owner);
    }

    function test_WithdrawAll_RevertWithdrawFailed_TransferFails() public {
        vm.prank(alice);
        qp.payForQuery();

        usdc.setFailTransfers(true);

        vm.prank(owner);
        vm.expectRevert(QueryPayment.WithdrawFailed.selector);
        qp.withdrawAll(owner);
    }

    // ================================================================
    // 12. Two-step ownership transfer — happy path
    // ================================================================

    function test_TransferOwnership_QueuesPendingOwner() public {
        vm.prank(owner);
        qp.transferOwnership(alice);

        assertEq(qp.pendingOwner(), alice);
        assertEq(qp.owner(),        owner); // still the old owner
    }

    function test_TransferOwnership_EmitsOwnershipTransferStarted() public {
        vm.prank(owner);
        vm.expectEmit(true, true, false, false, address(qp));
        emit QueryPayment.OwnershipTransferStarted(owner, alice);
        qp.transferOwnership(alice);
    }

    function test_AcceptOwnership_FinalisesPendingOwner() public {
        vm.prank(owner);
        qp.transferOwnership(alice);

        vm.prank(alice);
        qp.acceptOwnership();

        assertEq(qp.owner(),        alice);
        assertEq(qp.pendingOwner(), address(0));
    }

    function test_AcceptOwnership_EmitsOwnershipTransferred() public {
        vm.prank(owner);
        qp.transferOwnership(alice);

        vm.prank(alice);
        vm.expectEmit(true, true, false, false, address(qp));
        emit QueryPayment.OwnershipTransferred(owner, alice);
        qp.acceptOwnership();
    }

    function test_AcceptOwnership_NewOwnerCanWithdraw() public {
        vm.prank(owner);
        qp.transferOwnership(alice);

        vm.prank(alice);
        qp.acceptOwnership();

        vm.prank(bob);
        qp.payForQuery();

        vm.prank(alice);
        qp.withdrawAll(alice);
        assertEq(usdc.balanceOf(address(qp)), 0);
    }

    // ================================================================
    // 13. Two-step ownership — revert paths
    // ================================================================

    function test_TransferOwnership_RevertNotOwner() public {
        vm.prank(alice);
        vm.expectRevert(QueryPayment.NotOwner.selector);
        qp.transferOwnership(bob);
    }

    function test_TransferOwnership_RevertZeroAddress() public {
        vm.prank(owner);
        vm.expectRevert(QueryPayment.ZeroAddress.selector);
        qp.transferOwnership(address(0));
    }

    function test_AcceptOwnership_RevertNoPendingOwner_NoPendingSet() public {
        vm.prank(alice);
        vm.expectRevert(QueryPayment.NoPendingOwner.selector);
        qp.acceptOwnership();
    }

    function test_AcceptOwnership_RevertNoPendingOwner_WrongCaller() public {
        vm.prank(owner);
        qp.transferOwnership(alice);

        vm.prank(bob);
        vm.expectRevert(QueryPayment.NoPendingOwner.selector);
        qp.acceptOwnership();
    }

    // ================================================================
    // 14. setQueryFee / applyQueryFee — timelock
    // ================================================================

    function test_SetQueryFee_QueuesNewFee() public {
        uint256 newFee = 2e6;

        vm.prank(owner);
        qp.setQueryFee(newFee);

        assertEq(qp.pendingQueryFee(), newFee);
        assertEq(qp.pendingQueryFeeActiveAt(), block.timestamp + qp.FEE_CHANGE_DELAY());
        assertEq(qp.queryFee(), INIT_QUERY_FEE); // unchanged yet
    }

    function test_SetQueryFee_EmitsQueryFeeQueued() public {
        uint256 newFee = 2e6;
        uint256 expectedActiveAt = block.timestamp + qp.FEE_CHANGE_DELAY();

        vm.prank(owner);
        vm.expectEmit(false, false, false, true, address(qp));
        emit QueryPayment.QueryFeeQueued(newFee, expectedActiveAt);
        qp.setQueryFee(newFee);
    }

    function test_ApplyQueryFee_RevertsBeforeDelay() public {
        vm.prank(owner);
        qp.setQueryFee(2e6);

        // Just before the delay elapses.
        vm.warp(block.timestamp + qp.FEE_CHANGE_DELAY() - 1);

        vm.expectRevert(QueryPayment.DelayNotMet.selector);
        qp.applyQueryFee();
    }

    function test_ApplyQueryFee_AppliesAfterDelay() public {
        uint256 newFee = 2e6;
        vm.prank(owner);
        qp.setQueryFee(newFee);

        vm.warp(block.timestamp + qp.FEE_CHANGE_DELAY());

        qp.applyQueryFee();

        assertEq(qp.queryFee(),            newFee);
        assertEq(qp.pendingQueryFee(),     0);
        assertEq(qp.pendingQueryFeeActiveAt(), 0);
    }

    function test_ApplyQueryFee_EmitsQueryFeeUpdated() public {
        uint256 newFee = 2e6;
        vm.prank(owner);
        qp.setQueryFee(newFee);
        vm.warp(block.timestamp + qp.FEE_CHANGE_DELAY());

        vm.expectEmit(false, false, false, true, address(qp));
        emit QueryPayment.QueryFeeUpdated(INIT_QUERY_FEE, newFee);
        qp.applyQueryFee();
    }

    function test_ApplyQueryFee_RevertZeroFee_NoPending() public {
        // No setQueryFee called → pendingQueryFee == 0.
        vm.warp(block.timestamp + qp.FEE_CHANGE_DELAY() + 1);

        vm.expectRevert(QueryPayment.ZeroFee.selector);
        qp.applyQueryFee();
    }

    function test_SetQueryFee_RevertZeroFee() public {
        vm.prank(owner);
        vm.expectRevert(QueryPayment.ZeroFee.selector);
        qp.setQueryFee(0);
    }

    function test_SetQueryFee_RevertNotOwner() public {
        vm.prank(alice);
        vm.expectRevert(QueryPayment.NotOwner.selector);
        qp.setQueryFee(2e6);
    }

    // ================================================================
    // 15. setSubscriptionFee / applySubscriptionFee — timelock
    // ================================================================

    function test_SetSubscriptionFee_QueuesNewFee() public {
        uint256 newFee = 20e6;

        vm.prank(owner);
        qp.setSubscriptionFee(newFee);

        assertEq(qp.pendingSubscriptionFee(), newFee);
        assertEq(qp.pendingSubscriptionFeeActiveAt(), block.timestamp + qp.FEE_CHANGE_DELAY());
        assertEq(qp.subscriptionFee(), INIT_SUB_FEE); // unchanged yet
    }

    function test_SetSubscriptionFee_EmitsSubscriptionFeeQueued() public {
        uint256 newFee = 20e6;
        uint256 expectedActiveAt = block.timestamp + qp.FEE_CHANGE_DELAY();

        vm.prank(owner);
        vm.expectEmit(false, false, false, true, address(qp));
        emit QueryPayment.SubscriptionFeeQueued(newFee, expectedActiveAt);
        qp.setSubscriptionFee(newFee);
    }

    function test_ApplySubscriptionFee_RevertsBeforeDelay() public {
        vm.prank(owner);
        qp.setSubscriptionFee(20e6);

        vm.warp(block.timestamp + qp.FEE_CHANGE_DELAY() - 1);

        vm.expectRevert(QueryPayment.DelayNotMet.selector);
        qp.applySubscriptionFee();
    }

    function test_ApplySubscriptionFee_AppliesAfterDelay() public {
        uint256 newFee = 20e6;
        vm.prank(owner);
        qp.setSubscriptionFee(newFee);

        vm.warp(block.timestamp + qp.FEE_CHANGE_DELAY());

        qp.applySubscriptionFee();

        assertEq(qp.subscriptionFee(),            newFee);
        assertEq(qp.pendingSubscriptionFee(),     0);
        assertEq(qp.pendingSubscriptionFeeActiveAt(), 0);
    }

    function test_ApplySubscriptionFee_EmitsSubscriptionFeeUpdated() public {
        uint256 newFee = 20e6;
        vm.prank(owner);
        qp.setSubscriptionFee(newFee);
        vm.warp(block.timestamp + qp.FEE_CHANGE_DELAY());

        vm.expectEmit(false, false, false, true, address(qp));
        emit QueryPayment.SubscriptionFeeUpdated(INIT_SUB_FEE, newFee);
        qp.applySubscriptionFee();
    }

    function test_ApplySubscriptionFee_RevertZeroFee_NoPending() public {
        vm.warp(block.timestamp + qp.FEE_CHANGE_DELAY() + 1);

        vm.expectRevert(QueryPayment.ZeroFee.selector);
        qp.applySubscriptionFee();
    }

    function test_SetSubscriptionFee_RevertZeroFee() public {
        vm.prank(owner);
        vm.expectRevert(QueryPayment.ZeroFee.selector);
        qp.setSubscriptionFee(0);
    }

    function test_SetSubscriptionFee_RevertNotOwner() public {
        vm.prank(alice);
        vm.expectRevert(QueryPayment.NotOwner.selector);
        qp.setSubscriptionFee(20e6);
    }

    // ================================================================
    // 16. NotAContract error — coverage note
    // ================================================================
    // The NotAContract error is declared but never emitted in the current
    // source; there is no code path that triggers it.  We document that
    // here so the per-function matrix is complete.  This is recorded as a
    // suspected contract issue below.

    // ================================================================
    // 17. FUZZ — payForQuery with varying fees
    // ================================================================

    /// @dev The contract always charges `queryFee`; fuzz the fee itself by
    ///      queueing and applying a new fee, then verifying the transfer.
    function testFuzz_PayForQuery_ArbitraryFee(uint256 fee) public {
        fee = bound(fee, 1, SEED); // must be non-zero and ≤ alice's balance

        // Update queryFee via the timelock.
        vm.prank(owner);
        qp.setQueryFee(fee);
        vm.warp(block.timestamp + qp.FEE_CHANGE_DELAY());
        qp.applyQueryFee();

        assertEq(qp.queryFee(), fee);

        // Give alice enough allowance for the new fee.
        vm.prank(alice);
        usdc.approve(address(qp), fee);

        uint256 aliceBefore    = usdc.balanceOf(alice);
        uint256 contractBefore = usdc.balanceOf(address(qp));

        vm.prank(alice);
        qp.payForQuery();

        assertEq(usdc.balanceOf(alice),       aliceBefore    - fee);
        assertEq(usdc.balanceOf(address(qp)), contractBefore + fee);
        assertEq(qp.queriesByUser(alice),      1);
        assertEq(qp.totalQueriesPaid(),        1);
    }

    function testFuzz_PayForQuery_MultipleUsers(uint8 numUsers, uint256 fee) public {
        numUsers = uint8(bound(numUsers, 1, 10));
        fee      = bound(fee, 1, 1_000e6);

        vm.prank(owner);
        qp.setQueryFee(fee);
        vm.warp(block.timestamp + qp.FEE_CHANGE_DELAY());
        qp.applyQueryFee();

        for (uint256 i = 0; i < numUsers; i++) {
            address user = address(uint160(0xBEEF + i));
            usdc.mint(user, fee);
            vm.prank(user);
            usdc.approve(address(qp), fee);
            vm.prank(user);
            qp.payForQuery();
        }

        assertEq(qp.totalQueriesPaid(), numUsers);
        assertEq(usdc.balanceOf(address(qp)), fee * numUsers);
    }

    // ================================================================
    // 18. FUZZ — subscribe with varying subscription fees
    // ================================================================

    function testFuzz_Subscribe_ArbitraryFee(uint256 fee) public {
        fee = bound(fee, 1, SEED);

        vm.prank(owner);
        qp.setSubscriptionFee(fee);
        vm.warp(block.timestamp + qp.FEE_CHANGE_DELAY());
        qp.applySubscriptionFee();

        assertEq(qp.subscriptionFee(), fee);

        vm.prank(alice);
        usdc.approve(address(qp), fee);

        uint256 aliceBefore = usdc.balanceOf(alice);
        uint256 ts          = block.timestamp;

        vm.prank(alice);
        qp.subscribe();

        assertEq(usdc.balanceOf(alice),     aliceBefore - fee);
        assertEq(qp.subscriptionExpiry(alice), ts + 30 days);
        assertTrue(qp.isSubscribed(alice));
    }

    function testFuzz_Subscribe_StackingArbitraryFee(uint256 fee, uint8 times) public {
        times = uint8(bound(times, 2, 5));
        fee   = bound(fee, 1, SEED / times);

        vm.prank(owner);
        qp.setSubscriptionFee(fee);
        vm.warp(block.timestamp + qp.FEE_CHANGE_DELAY());
        qp.applySubscriptionFee();

        vm.prank(alice);
        usdc.approve(address(qp), fee * times);

        uint256 expectedExpiry = block.timestamp + 30 days;

        for (uint256 i = 0; i < times; i++) {
            vm.prank(alice);
            qp.subscribe();
            if (i > 0) {
                expectedExpiry += 30 days;
            }
        }

        assertEq(qp.subscriptionExpiry(alice), expectedExpiry);
    }

    // ================================================================
    // 19. INVARIANT — total USDC in contract = sum of all payments
    // ================================================================

    // NOTE: A stateful invariant handler would require a separate Handler
    // contract. Here we use a simple end-state invariant verified after a
    // known sequence of operations to keep the suite hermetic.

    function test_Invariant_ContractBalanceMatchesPayments() public {
        // alice pays for 3 queries, bob subscribes twice.
        vm.startPrank(alice);
        qp.payForQuery();
        qp.payForQuery();
        qp.payForQuery();
        vm.stopPrank();

        vm.startPrank(bob);
        qp.subscribe();
        qp.subscribe();
        vm.stopPrank();

        uint256 expected = INIT_QUERY_FEE * 3 + INIT_SUB_FEE * 2;
        assertEq(usdc.balanceOf(address(qp)), expected);
    }

    function test_Invariant_WithdrawReducesBalanceExactly() public {
        vm.prank(alice);
        qp.payForQuery();

        uint256 contractBefore = usdc.balanceOf(address(qp));

        vm.prank(owner);
        qp.withdraw(owner, INIT_QUERY_FEE);

        assertEq(usdc.balanceOf(address(qp)), contractBefore - INIT_QUERY_FEE);
    }
}
