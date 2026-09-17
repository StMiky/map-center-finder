# Map Center Finder

Finds the middle of a set of cities — the geographic **centre of mass** — and draws it
on a world map as a circular search area with a centre marker.

> [!NOTE]
> Yes, it is completey vibe-coded, except for this line.

## Run

```bash
python3 finder.py                       # opens the UI in your browser
python3 finder.py Turin Milan Genoa     # pre-load cities and solve immediately
```

No dependencies beyond the Python standard library; the map (Leaflet + OpenStreetMap
tiles) and the geocoder are loaded from the network at runtime.

Options: `--port` (default 8765, falls back to a free port), `--host`, `--no-browser`, `-v`.

## Using the UI

1. Type a city in row 1 and row 2; pick one of the suggestions (or press Enter to take
   the best match).
2. **+ Add city** appends more rows; `×` removes one (two rows are always kept).
3. **Find the centre** computes the centre of mass, zooms to it, and draws the circle.
4. The **Search area** slider scales the circle radius; the panel lists the distance
   from the centre to every city and reverse-geocodes the centre to a place name.

## How the centre is computed

Each city is converted to a unit vector on the sphere, the vectors are averaged with
equal weight, and the mean is projected back to the surface. This is the true centre of
mass of the points, and unlike averaging latitude/longitude it behaves correctly across
the antimeridian and near the poles. Distances use the haversine formula on a sphere of
radius 6 371 008.8 m. Exactly antipodal inputs have no defined centre and are reported
as such.

The circle radius defaults to 35 % of the average distance from the centre to the
cities, so it scales with how spread out they are.

## Geocoding

Lookups are proxied through `finder.py` to [Nominatim](https://nominatim.org) so they
carry a proper `User-Agent`, are cached, and are rate-limited to one request per second
as the OSM usage policy requires. That is also why pre-loaded cities resolve one per
second on start-up.
