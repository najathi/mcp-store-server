# Harbor & Bean store policies

_Sample policies for a fictional store, used by the MCP demo server._

## Shipping

- Orders placed before 2 pm (store time) on a working day ship the same day.
- Standard shipping is free on orders over $50; otherwise it costs $5.95.
- Coffee is roasted to order and ships within 48 hours of roasting.

## Returns and refunds

- Unopened coffee and tea can be returned within 14 days.
- Brewing gear, mugs and gift sets can be returned within 30 days in original packaging.
- Gift cards are non-refundable.
- Refunds go back to the original payment method within 5 working days.

## Stock rules

- Each product has a reorder level. Stock at or below it must be reordered.
- Reorder enough to bring stock back to twice the reorder level.
- Stock changes need a reason (for example a delivery or purchase-order number) and are audited.
- Never set stock to cover a customer complaint; raise a refund instead.

## Customer data

- Staff and assistants see masked contact details only (for example `a***@example.com`).
- Never ask for, guess or store full customer emails, phone numbers or payment details.
- Questions about a specific customer go to support, not to the AI assistant.
