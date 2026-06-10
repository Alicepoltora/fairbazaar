// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * FairBazaar — a digital goods marketplace on OPN Chain.
 *
 * The chain is load-bearing five times over:
 *   1. Escrow & atomic settlement   — funds are locked by contract, not by a company.
 *   2. Proof of delivery            — the decryption key is handed over inside a
 *                                     transaction, so "I sent it" is verifiable.
 *   3. On-chain AI court            — the arbiter's verdict and its reasoning hash
 *                                     are published on-chain; the court is auditable.
 *   4. Soulbound reputation         — seller scores are earned, not bought, and
 *                                     cannot be transferred.
 *   5. Trustless timeouts           — no delivery => automatic refund; no dispute
 *                                     => automatic payout. Nobody can sit on funds.
 *
 * Trade flow:
 *   seller.createListing(secret encrypted to delivery agent)
 *   buyer.buy{value: price}(listingId, buyerEncryptionPubKey)
 *   agent.deliver(orderId, secret re-encrypted to buyer)     [auto, event-driven]
 *   -- happy path: after disputeWindow anyone can finalize() -> seller is paid
 *   -- unhappy:    buyer.openDispute(stake) -> AI arbiter resolveDispute() on-chain
 *   -- no delivery: buyer.claimRefund() after deliveryWindow
 */
contract FairBazaar {
    // ---------------------------------------------------------------- types

    enum OrderStatus {
        None,
        Paid,       // escrow funded, waiting for delivery
        Delivered,  // key published on-chain, dispute window open
        Disputed,   // buyer staked a dispute, waiting for arbiter
        Completed,  // seller paid out
        Refunded,   // buyer refunded (no delivery in time)
        Resolved    // closed by arbiter verdict
    }

    enum Verdict {
        None,
        BuyerWins,  // full refund, stake returned
        SellerWins, // seller gets price + buyer's stake
        Split       // 50/50, stake returned
    }

    struct Listing {
        address seller;
        uint96 price;
        bool active;
        uint64 salesCount;
        string title;
        string description;      // the canonical promise the AI judges against
        bytes encSecretForAgent; // goods secret, encrypted to the delivery agent
    }

    struct Order {
        uint256 listingId;
        address buyer;
        uint96 price;        // snapshot at purchase time
        uint96 disputeStake;
        uint64 paidAt;
        uint64 deliveredAt;
        OrderStatus status;
        bytes32 buyerPubKey; // X25519 key the secret is re-encrypted to
    }

    struct Reputation {
        uint64 sales;
        uint64 disputesWon;
        uint64 disputesLost;
        uint128 volume; // lifetime wei earned honestly
    }

    struct Dispute {
        string reason;    // buyer's complaint, fixed at dispute time
        Verdict verdict;
        string reasoning; // the arbiter's published rationale
    }

    // ---------------------------------------------------------------- state

    address public owner;
    address public deliveryAgent; // off-chain bot that re-encrypts & delivers
    address public arbiter;       // AI agent wallet, publishes verdicts

    uint64 public deliveryWindow; // no delivery within it => refund
    uint64 public disputeWindow;  // delivered + window passed => seller paid
    uint16 public disputeStakeBps; // dispute stake as bps of price
    uint16 public feeBps;          // marketplace fee
    uint256 public accruedFees;

    uint256 public nextListingId = 1;
    uint256 public nextOrderId = 1;

    mapping(uint256 => Listing) public listings;
    mapping(uint256 => Order) public orders;
    mapping(address => Reputation) public reputation; // soulbound by construction
    // Stored in state (not just events): OPN RPC caps eth_getLogs ranges, and the
    // buyer must be able to fetch their goods forever via a simple eth_call.
    mapping(uint256 => bytes) public deliveredPayload; // orderId => goods sealed to buyer
    mapping(uint256 => Dispute) public disputes;       // orderId => dispute record

    bool private locked;

    // ---------------------------------------------------------------- events

    event ListingCreated(uint256 indexed listingId, address indexed seller, uint96 price, string title);
    event ListingToggled(uint256 indexed listingId, bool active);
    event Purchased(uint256 indexed orderId, uint256 indexed listingId, address indexed buyer, uint96 price, bytes32 buyerPubKey);
    event Delivered(uint256 indexed orderId, bytes encSecretForBuyer);
    event RefundClaimed(uint256 indexed orderId);
    event DisputeOpened(uint256 indexed orderId, address indexed buyer, string reason);
    event DisputeResolved(uint256 indexed orderId, Verdict verdict, string reasoning);
    event OrderCompleted(uint256 indexed orderId, address indexed seller, uint256 payout);
    event ReputationChanged(address indexed seller, uint64 sales, uint64 disputesWon, uint64 disputesLost);

    // ---------------------------------------------------------------- setup

    constructor(address _agent, address _arbiter, uint64 _deliveryWindow, uint64 _disputeWindow, uint16 _disputeStakeBps, uint16 _feeBps) {
        require(_feeBps <= 1000, "fee too high");
        owner = msg.sender;
        deliveryAgent = _agent;
        arbiter = _arbiter;
        deliveryWindow = _deliveryWindow;
        disputeWindow = _disputeWindow;
        disputeStakeBps = _disputeStakeBps;
        feeBps = _feeBps;
    }

    modifier onlyOwner() { require(msg.sender == owner, "not owner"); _; }
    modifier nonReentrant() { require(!locked, "reentrancy"); locked = true; _; locked = false; }

    function setAgents(address _agent, address _arbiter) external onlyOwner {
        deliveryAgent = _agent;
        arbiter = _arbiter;
    }

    // ---------------------------------------------------------------- selling

    /// Seller lists a digital good. The secret (license key, download key, etc.)
    /// is stored encrypted to the delivery agent so sales work 24/7 with the
    /// seller offline. The plaintext never touches the chain.
    function createListing(string calldata title, string calldata description, uint96 price, bytes calldata encSecretForAgent) external returns (uint256 id) {
        require(price > 0, "price=0");
        require(bytes(title).length > 0 && bytes(title).length <= 100, "bad title");
        require(bytes(description).length > 0 && bytes(description).length <= 2000, "bad description");
        require(encSecretForAgent.length > 0 && encSecretForAgent.length <= 4096, "bad secret");

        id = nextListingId++;
        listings[id] = Listing({
            seller: msg.sender,
            price: price,
            active: true,
            salesCount: 0,
            title: title,
            description: description,
            encSecretForAgent: encSecretForAgent
        });
        emit ListingCreated(id, msg.sender, price, title);
    }

    function setListingActive(uint256 listingId, bool active) external {
        Listing storage l = listings[listingId];
        require(l.seller == msg.sender, "not seller");
        l.active = active;
        emit ListingToggled(listingId, active);
    }

    // ---------------------------------------------------------------- buying

    /// One-click purchase. Funds go to escrow, never to the seller directly.
    /// buyerPubKey is an X25519 public key generated in the buyer's browser;
    /// the delivery agent encrypts the goods secret to it.
    function buy(uint256 listingId, bytes32 buyerPubKey) external payable returns (uint256 id) {
        Listing storage l = listings[listingId];
        require(l.active, "inactive listing");
        require(msg.value == l.price, "wrong price");
        require(msg.sender != l.seller, "self-buy");
        require(buyerPubKey != bytes32(0), "no pubkey");

        id = nextOrderId++;
        orders[id] = Order({
            listingId: listingId,
            buyer: msg.sender,
            price: l.price,
            disputeStake: 0,
            paidAt: uint64(block.timestamp),
            deliveredAt: 0,
            status: OrderStatus.Paid,
            buyerPubKey: buyerPubKey
        });
        emit Purchased(id, listingId, msg.sender, l.price, buyerPubKey);
    }

    // ---------------------------------------------------------------- delivery

    /// The delivery agent (or the seller manually) publishes the goods secret
    /// re-encrypted to the buyer. The transaction itself is the proof of delivery.
    function deliver(uint256 orderId, bytes calldata encSecretForBuyer) external {
        Order storage o = orders[orderId];
        require(o.status == OrderStatus.Paid, "not paid state");
        Listing storage l = listings[o.listingId];
        require(msg.sender == deliveryAgent || msg.sender == l.seller, "not deliverer");
        require(encSecretForBuyer.length > 0 && encSecretForBuyer.length <= 4096, "bad payload");

        o.status = OrderStatus.Delivered;
        o.deliveredAt = uint64(block.timestamp);
        deliveredPayload[orderId] = encSecretForBuyer;
        emit Delivered(orderId, encSecretForBuyer);
    }

    /// No delivery inside the window => trustless refund. Nobody's permission needed.
    function claimRefund(uint256 orderId) external nonReentrant {
        Order storage o = orders[orderId];
        require(o.buyer == msg.sender, "not buyer");
        require(o.status == OrderStatus.Paid, "not refundable");
        require(block.timestamp > o.paidAt + deliveryWindow, "too early");

        o.status = OrderStatus.Refunded;
        _pay(o.buyer, o.price);
        emit RefundClaimed(orderId);
    }

    // ---------------------------------------------------------------- disputes

    /// Buyer disputes a delivered order ("goods don't match the description").
    /// The stake makes frivolous disputes expensive: lose and it goes to the seller.
    function openDispute(uint256 orderId, string calldata reason) external payable {
        Order storage o = orders[orderId];
        require(o.buyer == msg.sender, "not buyer");
        require(o.status == OrderStatus.Delivered, "not delivered state");
        require(block.timestamp <= o.deliveredAt + disputeWindow, "window closed");
        require(bytes(reason).length > 0 && bytes(reason).length <= 2000, "bad reason");
        uint256 stake = (uint256(o.price) * disputeStakeBps) / 10000;
        require(msg.value == stake, "wrong stake");

        o.status = OrderStatus.Disputed;
        o.disputeStake = uint96(stake);
        disputes[orderId].reason = reason;
        emit DisputeOpened(orderId, msg.sender, reason);
    }

    /// The AI arbiter publishes its verdict together with its reasoning, making
    /// every ruling of the court permanently auditable on-chain.
    function resolveDispute(uint256 orderId, Verdict verdict, string calldata reasoning) external nonReentrant {
        require(msg.sender == arbiter, "not arbiter");
        Order storage o = orders[orderId];
        require(o.status == OrderStatus.Disputed, "not disputed");
        require(verdict != Verdict.None, "bad verdict");

        Listing storage l = listings[o.listingId];
        Reputation storage rep = reputation[l.seller];
        o.status = OrderStatus.Resolved;
        disputes[orderId].verdict = verdict;
        disputes[orderId].reasoning = reasoning;

        if (verdict == Verdict.BuyerWins) {
            rep.disputesLost++;
            _pay(o.buyer, uint256(o.price) + o.disputeStake);
        } else if (verdict == Verdict.SellerWins) {
            rep.disputesWon++;
            rep.sales++;
            rep.volume += o.price;
            uint256 fee = (uint256(o.price) * feeBps) / 10000;
            accruedFees += fee;
            _pay(l.seller, uint256(o.price) - fee + o.disputeStake);
        } else {
            // Split: half each, stake returned — an honest misunderstanding.
            uint256 half = uint256(o.price) / 2;
            _pay(o.buyer, half + o.disputeStake);
            _pay(l.seller, uint256(o.price) - half);
        }

        emit DisputeResolved(orderId, verdict, reasoning);
        emit ReputationChanged(l.seller, rep.sales, rep.disputesWon, rep.disputesLost);
    }

    // ---------------------------------------------------------------- settlement

    /// Delivered + dispute window passed + no dispute => seller gets paid.
    /// Callable by anyone, so settlement can be automated and censorship-free.
    function finalize(uint256 orderId) external nonReentrant {
        Order storage o = orders[orderId];
        require(o.status == OrderStatus.Delivered, "not delivered state");
        require(block.timestamp > o.deliveredAt + disputeWindow, "window open");

        Listing storage l = listings[o.listingId];
        o.status = OrderStatus.Completed;
        l.salesCount++;

        Reputation storage rep = reputation[l.seller];
        rep.sales++;
        rep.volume += o.price;

        uint256 fee = (uint256(o.price) * feeBps) / 10000;
        accruedFees += fee;
        _pay(l.seller, uint256(o.price) - fee);

        emit OrderCompleted(orderId, l.seller, uint256(o.price) - fee);
        emit ReputationChanged(l.seller, rep.sales, rep.disputesWon, rep.disputesLost);
    }

    function withdrawFees(address to) external onlyOwner nonReentrant {
        uint256 amount = accruedFees;
        accruedFees = 0;
        _pay(to, amount);
    }

    // ---------------------------------------------------------------- views

    /// Honest-trade score: sales build it, lost disputes burn it fast.
    function sellerScore(address seller) external view returns (uint256) {
        Reputation storage rep = reputation[seller];
        uint256 positive = uint256(rep.sales) * 10 + uint256(rep.disputesWon) * 5;
        uint256 negative = uint256(rep.disputesLost) * 40;
        return positive > negative ? positive - negative : 0;
    }

    function getListing(uint256 id) external view returns (Listing memory) { return listings[id]; }
    function getOrder(uint256 id) external view returns (Order memory) { return orders[id]; }
    function getDispute(uint256 id) external view returns (Dispute memory) { return disputes[id]; }
    function getDelivered(uint256 id) external view returns (bytes memory) { return deliveredPayload[id]; }

    // ---------------------------------------------------------------- internal

    function _pay(address to, uint256 amount) internal {
        if (amount == 0) return;
        (bool ok, ) = to.call{value: amount}("");
        require(ok, "transfer failed");
    }
}
