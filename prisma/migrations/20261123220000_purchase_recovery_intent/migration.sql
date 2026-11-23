CREATE OR REPLACE FUNCTION preserve_corporate_refund_audit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.operation IN ('admin_refund_ticket','admin_cancel_event','admin_recover_purchase') THEN RAISE EXCEPTION 'Original corporate financial intent is immutable'; END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END $$;
