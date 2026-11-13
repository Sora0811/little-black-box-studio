export class DeliveryError extends Error {
    constructor(message, details = {}) {
        super(message);
        this.name = 'DeliveryError';
        this.code = details.code ?? 'DELIVERY_ERROR';
        this.status = details.status ?? null;
        this.detail = details.detail ?? null;
        // True when Discord may have accepted the message even though the call
        // failed: the caller must look in the channel before resending.
        this.ambiguous = details.ambiguous === true;
    }
}
