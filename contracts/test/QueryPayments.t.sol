// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {QueryPayments} from "../QueryPayments.sol";

// ---------------------------------------------------------------------------
// Helper: a treasury that always reverts on receive (test 11)
// ---------------------------------------------------------------------------
contract RevertingTreasury {
    receive() external payable {
        revert("I refuse ETH");
    }
}

// ---------------------------------------------------------------------------
// Main test suite
// ---------------------------------------------------------------------------
contract QueryPaymentsTest is Test {
    QueryPayments internal qp;

    address internal deployer  = makeAddr("deployer");
    address internal treasury  = makeAddr("treasury");   // plain EOA – can receive ETH
    address internal alice     = makeAddr("alice");
    address internal bob       = makeAddr("bob");

    uint256 internal constant PRICE = 1e16; // 0.01 USDC-native (18 dec)

    bytes32 internal constant QID_A = keccak256("query-A");
    bytes32 internal constant QID_B = keccak256("query-B");

    // -----------------------------------------------------------------------
    // setUp – runs before every test; gives actors some ETH
    // -----------------------------------------------------------------------
    function setUp() public {
        vm.deal(alice, 10 ether);
        vm.deal(bob,   10 ether);

        vm.prank(deployer);
        qp = new QueryPayments(treasury, PRICE);
    }

    // -----------------------------------------------------------------------
    // 1. Deployment & initialization
    // -----------------------------------------------------------------------

    function test_Constructor_SetsOwnerTreasuryPrice() public view {
        assertEq(qp.owner(),    deployer);
        assertEq(qp.treasury(), treasury);
        assertEq(qp.price(),    PRICE);
    }

    function test_Constructor_RevertsOnZeroTreasury() public {
        vm.expectRevert(bytes("Zero address"));
        new QueryPayments(address(0), PRICE);
    }

    function test_Constructor_RevertsOnZeroPrice() public {
        vm.expectRevert(bytes("Price must be > 0"));
        new QueryPayments(treasury, 0);
    }

    // -----------------------------------------------------------------------
    // 2. pay() – happy path (test point 1 + event test point 8)
    // -----------------------------------------------------------------------

    function test_Pay_ExactAmount_TreasuryReceivesFullAmount() public {
        uint256 treasuryBefore = treasury.balance;

        vm.prank(alice);
        qp.pay{value: PRICE}(QID_A);

        assertEq(treasury.balance, treasuryBefore + PRICE, "treasury balance mismatch");
    }

    function test_Pay_MarksQueryIdUsed() public {
        assertFalse(qp.queryIdUsed(QID_A));

        vm.prank(alice);
        qp.pay{value: PRICE}(QID_A);

        assertTrue(qp.queryIdUsed(QID_A));
    }

    // Test point 8: QueryPaid emitted with correct queryId, payer, amount
    function test_Pay_EmitsQueryPaid() public {
        vm.prank(alice);
        vm.expectEmit(true, true, false, true, address(qp));
        emit QueryPayments.QueryPaid(QID_A, alice, PRICE);
        qp.pay{value: PRICE}(QID_A);
    }

    // -----------------------------------------------------------------------
    // 3. pay() – revert paths (test points 2 & 3)
    // -----------------------------------------------------------------------

    // Test point 2a: underpayment
    function test_Pay_RevertsOnUnderpayment() public {
        vm.prank(alice);
        vm.expectRevert(bytes("Wrong payment amount"));
        qp.pay{value: PRICE - 1}(QID_A);
    }

    // Test point 2b: overpayment
    function test_Pay_RevertsOnOverpayment() public {
        vm.prank(alice);
        vm.expectRevert(bytes("Wrong payment amount"));
        qp.pay{value: PRICE + 1}(QID_A);
    }

    // Test point 3: reused queryId
    function test_Pay_RevertsOnReusedQueryId() public {
        vm.prank(alice);
        qp.pay{value: PRICE}(QID_A);

        vm.prank(bob);
        vm.expectRevert(bytes("QueryId already used"));
        qp.pay{value: PRICE}(QID_A);
    }

    // Test point 11: failing treasury reverts the whole payment
    function test_Pay_RevertsWhenTreasuryReverts() public {
        // Deploy a reverting treasury and point the contract at it
        RevertingTreasury rt = new RevertingTreasury();
        vm.prank(deployer);
        qp.setTreasury(address(rt));

        vm.prank(alice);
        vm.expectRevert(bytes("Treasury transfer failed"));
        qp.pay{value: PRICE}(QID_A);
    }

    // -----------------------------------------------------------------------
    // 4 & 5. setPrice / setTreasury – access control (test points 4, 5)
    // -----------------------------------------------------------------------

    function test_SetPrice_RevertsForNonOwner() public {
        vm.prank(alice);
        vm.expectRevert(bytes("Not owner"));
        qp.setPrice(2e16);
    }

    function test_SetTreasury_RevertsForNonOwner() public {
        vm.prank(alice);
        vm.expectRevert(bytes("Not owner"));
        qp.setTreasury(alice);
    }

    // -----------------------------------------------------------------------
    // 6 & 7. setPrice(0) and setTreasury(address(0)) validation
    // -----------------------------------------------------------------------

    // Test point 6: setPrice(0) reverts
    function test_SetPrice_RevertsOnZero() public {
        vm.prank(deployer);
        vm.expectRevert(bytes("Price must be > 0"));
        qp.setPrice(0);
    }

    // Test point 7: setTreasury(address(0)) reverts
    function test_SetTreasury_RevertsOnZeroAddress() public {
        vm.prank(deployer);
        vm.expectRevert(bytes("Zero address"));
        qp.setTreasury(address(0));
    }

    // -----------------------------------------------------------------------
    // setPrice happy path + event (test point 9)
    // -----------------------------------------------------------------------

    function test_SetPrice_UpdatesPrice() public {
        uint256 newPrice = 5e16;
        vm.prank(deployer);
        qp.setPrice(newPrice);
        assertEq(qp.price(), newPrice);
    }

    // Test point 9: PriceUpdated emitted with old and new price
    function test_SetPrice_EmitsPriceUpdated() public {
        uint256 newPrice = 5e16;
        vm.prank(deployer);
        vm.expectEmit(false, false, false, true, address(qp));
        emit QueryPayments.PriceUpdated(PRICE, newPrice);
        qp.setPrice(newPrice);
    }

    // -----------------------------------------------------------------------
    // setTreasury happy path + event (test point 10)
    // -----------------------------------------------------------------------

    function test_SetTreasury_UpdatesTreasury() public {
        address newTreasury = makeAddr("newTreasury");
        vm.prank(deployer);
        qp.setTreasury(newTreasury);
        assertEq(qp.treasury(), newTreasury);
    }

    // Test point 10: TreasuryUpdated emitted with old and new treasury
    function test_SetTreasury_EmitsTreasuryUpdated() public {
        address newTreasury = makeAddr("newTreasury");
        vm.prank(deployer);
        vm.expectEmit(true, true, false, false, address(qp));
        emit QueryPayments.TreasuryUpdated(treasury, newTreasury);
        qp.setTreasury(newTreasury);
    }

    // -----------------------------------------------------------------------
    // 12. transferOwnership (test point 12)
    // -----------------------------------------------------------------------

    function test_TransferOwnership_ChangesOwner() public {
        vm.prank(deployer);
        qp.transferOwnership(alice);
        assertEq(qp.owner(), alice);
    }

    function test_TransferOwnership_OldOwnerCanNoLongerSetPrice() public {
        vm.prank(deployer);
        qp.transferOwnership(alice);

        vm.prank(deployer);
        vm.expectRevert(bytes("Not owner"));
        qp.setPrice(9e16);
    }

    function test_TransferOwnership_NewOwnerCanSetPrice() public {
        vm.prank(deployer);
        qp.transferOwnership(alice);

        vm.prank(alice);
        qp.setPrice(9e16);
        assertEq(qp.price(), 9e16);
    }

    function test_TransferOwnership_RevertsForNonOwner() public {
        vm.prank(alice);
        vm.expectRevert(bytes("Not owner"));
        qp.transferOwnership(bob);
    }

    function test_TransferOwnership_RevertsOnZeroAddress() public {
        vm.prank(deployer);
        vm.expectRevert(bytes("Zero address"));
        qp.transferOwnership(address(0));
    }

    // -----------------------------------------------------------------------
    // Fuzz: any wrong amount always reverts
    // -----------------------------------------------------------------------

    function testFuzz_Pay_RevertsOnWrongAmount(uint256 wrongAmount) public {
        // Exclude the exact price – that should succeed
        vm.assume(wrongAmount != PRICE);
        // Keep value reasonable to avoid arithmetic overflow in deal
        wrongAmount = bound(wrongAmount, 0, 100 ether);

        vm.deal(alice, wrongAmount);
        vm.prank(alice);
        vm.expectRevert(bytes("Wrong payment amount"));
        qp.pay{value: wrongAmount}(QID_A);
    }

    // Fuzz: every distinct queryId can be paid exactly once
    function testFuzz_Pay_UniqueQueryIdsSucceed(bytes32 qid1, bytes32 qid2) public {
        vm.assume(qid1 != qid2);

        vm.prank(alice);
        qp.pay{value: PRICE}(qid1);

        vm.prank(bob);
        qp.pay{value: PRICE}(qid2);

        assertTrue(qp.queryIdUsed(qid1));
        assertTrue(qp.queryIdUsed(qid2));
    }
}
