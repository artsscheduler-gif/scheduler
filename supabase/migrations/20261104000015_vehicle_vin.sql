-- A car's VIN (shop exports and the customer's account page). Plate stays in notes.
alter table arts.vehicles add column vin text check (vin is null or vin ~ '^[A-HJ-NPR-Z0-9]{11,17}$');
create index vehicles_vin_idx on arts.vehicles (vin) where vin is not null;
