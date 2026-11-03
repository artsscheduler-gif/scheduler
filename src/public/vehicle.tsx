import { useEffect, useState } from 'react';

// Year / make / model pickers. Models come from NHTSA's free vPIC API (CORS-open,
// no key). Anything not listed, or any lookup failure, falls back to typing.
// Field names stay year / make / model so the booking form reads them as before.

const OTHER = '__other';

const MAKES = [
  'Acura', 'Alfa Romeo', 'Audi', 'BMW', 'Buick', 'Cadillac', 'Chevrolet', 'Chrysler', 'Dodge', 'Fiat',
  'Ford', 'Genesis', 'GMC', 'Honda', 'Hyundai', 'Infiniti', 'Jaguar', 'Jeep', 'Kia', 'Land Rover',
  'Lexus', 'Lincoln', 'Mazda', 'Mercedes-Benz', 'Mercury', 'Mini', 'Mitsubishi', 'Nissan', 'Pontiac',
  'Porsche', 'Ram', 'Saab', 'Saturn', 'Scion', 'Subaru', 'Tesla', 'Toyota', 'Volkswagen', 'Volvo',
];

// Passenger cars, SUVs/minivans and pickups are separate vehicle types in vPIC.
const TYPES = ['car', 'multipurpose passenger vehicle (mpv)', 'truck'];

async function fetchModels(year: string, make: string, signal: AbortSignal): Promise<string[]> {
  const base = 'https://vpic.nhtsa.dot.gov/api/vehicles/GetModelsForMakeYear';
  const lists = await Promise.all(TYPES.map(async (t) => {
    const r = await fetch(`${base}/make/${encodeURIComponent(make)}/modelyear/${year}/vehicletype/${encodeURIComponent(t)}?format=json`, { signal });
    if (!r.ok) throw new Error(`vpic ${r.status}`);
    const j = (await r.json()) as { Results?: { Model_Name: string }[] };
    return (j.Results ?? []).map((m) => m.Model_Name.trim());
  }));
  return [...new Set(lists.flat())].filter(Boolean).sort((a, b) => a.localeCompare(b));
}

export function VehicleFields({ errFor }: { errFor: (field: string) => boolean | undefined }) {
  const thisYear = new Date().getFullYear();
  const years = Array.from({ length: thisYear + 1 - 1980 + 1 }, (_, i) => String(thisYear + 1 - i));
  const [year, setYear] = useState('');
  const [make, setMake] = useState('');
  const [model, setModel] = useState('');
  const [models, setModels] = useState<string[] | null>(null);
  const [loading, setLoading] = useState(false);

  const knownYear = /^\d{4}$/.test(year);
  const makeTyped = make === OTHER;
  // Type the model when the make is typed, the year is unknown, or the lookup came back empty or failed.
  const modelTyped = makeTyped || !knownYear || model === OTHER || (models !== null && models.length === 0);

  useEffect(() => {
    setModel('');
    setModels(null);
    if (!knownYear || !make || makeTyped) return;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 6000);
    setLoading(true);
    fetchModels(year, make, ctl.signal)
      .then(setModels)
      .catch(() => setModels([]))
      .finally(() => { clearTimeout(timer); setLoading(false); });
    return () => { clearTimeout(timer); ctl.abort(); };
  }, [year, make]);

  return (
    <div className="row3">
      <label className={`field ${errFor('vehicle.year') ? 'bad' : ''}`}>
        <span>Year</span>
        <select value={year} onChange={(e) => setYear(e.target.value)}>
          <option value="">Year</option>
          {years.map((y) => <option key={y} value={y}>{y}</option>)}
          <option value="older">Older / not sure</option>
        </select>
        <input type="hidden" name="year" value={knownYear ? year : ''} />
      </label>
      <label className={`field ${errFor('vehicle.make') ? 'bad' : ''}`}>
        <span>Make</span>
        {makeTyped ? (
          <input name="make" required maxLength={40} placeholder="Make" autoFocus />
        ) : (
          <select name="make" required value={make} onChange={(e) => setMake(e.target.value)}>
            <option value="">Make</option>
            {MAKES.map((m) => <option key={m} value={m}>{m}</option>)}
            <option value={OTHER}>Not listed</option>
          </select>
        )}
      </label>
      <label className={`field ${errFor('vehicle.model') ? 'bad' : ''}`}>
        <span>Model</span>
        {loading ? (
          <select disabled><option>Loading…</option></select>
        ) : modelTyped ? (
          <input name="model" required maxLength={60} placeholder="Model" autoFocus={model === OTHER} />
        ) : (
          <select name="model" required value={model} onChange={(e) => setModel(e.target.value)} disabled={!make}>
            <option value="">Model</option>
            {(models ?? []).map((m) => <option key={m} value={m}>{m}</option>)}
            <option value={OTHER}>Not listed</option>
          </select>
        )}
      </label>
    </div>
  );
}
