# Security Specification for DEPOTEK Hub

## 1. Data Invariants
- A **Stock** item must always be linked to a valid **Depot**.
- A **Movement** cannot exist without a valid **Stock** reference and an authenticated **User**.
- **Containers** can only be updated by Logistics staff or Admins.
- **Alerts** are system-generated or user-acknowledged.
- **Documents** must have a creator and stay linked to their original category.

## 2. The "Dirty Dozen" Payloads (Red Team Test Cases)
1. **Identity Spoofing**: Attempt to create a document with `createdBy` set to another user's UID.
2. **Privilege Escalation**: Attempt to update own `role` in the `users` collection.
3. **Ghost Field Update**: Update a Depot but inject `isAdmin: true` into the request.
4. **Orphaned Stock**: Create a Stock item with a `depotId` that does not exist.
5. **Negative Inventory**: Update Stock with a negative `quantity`.
6. **State Jumping**: Update a Container status directly from `at_sea` to `archived`, skipping `port_arrival`.
7. **Resource Poisoning**: Create an entity with a 2MB string in a text field.
8. **PII Leakage**: Authenticated non-admin user attempts to read another user's `email`.
9. **History Tampering**: Attempt to update a Movement's `timestamp` or `type`.
10. **Terminal State Break**: Attempt to update a Container once it is marked as `departed_depot`.
11. **Path Poisoning**: Inject a malicious string into a `depotId` or `stockId` path variable.
12. **Unverified Access**: Attempt a write/read without an email-verified token.

## 3. Test Runner (Draft Plan)
- Verify `isSignedIn()` requires email verification.
- Verify `hasRole()` correctly checks the `/users` collection.
- Verify `isValidStock()` ensures relational integrity.
- Verify `affectedKeys()` gates all updates.
