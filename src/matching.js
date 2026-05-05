'use strict'

function crosses (takerSide, takerPrice, makerPrice) {
  return takerSide === 'buy'
    ? takerPrice >= makerPrice
    : takerPrice <= makerPrice
}

function findCandidates (takerOrder, book) {
  const candidates = []
  let need = takerOrder.remaining
  const opposite = book.iterateOpposite(takerOrder.side)
  for (const maker of opposite) {
    if (need <= 0) break
    if (!crosses(takerOrder.side, takerOrder.price, maker.price)) break
    const qty = Math.min(need, maker.remaining)
    candidates.push({
      makerOrderId: maker.id,
      ownerNodeId: maker.ownerNodeId,
      price: maker.price,
      qty
    })
    need -= qty
  }
  return candidates
}

module.exports = { findCandidates, crosses }
