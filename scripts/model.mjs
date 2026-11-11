// Kestrel-6U: a synthetic 6U Earth-observation CubeSat program used as the demo project.
// Limits marked [CDS] come from the CubeSat Design Specification Rev 14.1 (Cal Poly, 2022): 6U mass <= 12.0 kg.
// Other numbers are typical public datasheet values (18650 Li-ion cells ~47 g / 3.2 Ah / 3.6 V; 29.5% triple-junction
// cells; 500 km SSO: 94.6 min orbit, 35.5 min max eclipse). Program allocations and tolerances are assumptions.
// Run: node scripts/model.mjs  -> data/model.json
import { writeFileSync } from 'node:fs';

const V = (id, name, unit, nominal, tol, tolKind, system, source = '') => ({ id, name, unit, nominal, tol, tolKind, system, source });
const values = [
  V('m_struct', 'Structure mass (6U frame)', 'kg', 1.2, 3, 'pct', 'structure', 'COTS 6U structure datasheets 1.0-1.3 kg'),
  V('m_harness', 'Harness mass', 'kg', 0.3, 15, 'pct', 'structure'),
  V('m_fast', 'Fasteners and brackets mass', 'kg', 0.15, 15, 'pct', 'structure'),
  V('m_panels', 'Deployable solar panels mass (4)', 'kg', 1.08, 4, 'pct', 'solar'),
  V('area_cells', 'Illuminated cell area', 'm²', 0.12, 2, 'pct', 'solar'),
  V('eff_cells', 'Solar cell efficiency (BOL)', '', 0.295, 2, 'pct', 'solar', '29.5% triple-junction GaAs'),
  V('cos_avg', 'Orbit-average incidence factor', '', 0.62, 5, 'pct', 'adcs'),
  V('sun_frac', 'Sunlit fraction of orbit', '', 0.625, 1, 'pct', 'mission', '500 km SSO: 35.5 of 94.6 min in eclipse'),
  V('n_cells', 'Battery cells', 'count', 8, 0, 'abs', 'battery'),
  V('m_cell', 'Cell mass', 'kg', 0.047, 2, 'pct', 'battery', '18650 Li-ion'),
  V('cap_ah', 'Cell capacity (BOL)', 'Ah', 3.2, 3, 'pct', 'battery', '18650 Li-ion'),
  V('v_cell', 'Cell nominal voltage', 'V', 3.6, 0, 'abs', 'battery'),
  V('r_int', 'Cell internal resistance', 'Ω', 0.045, 10, 'pct', 'battery'),
  V('eta_batt', 'Battery discharge efficiency', '', 0.95, 1, 'pct', 'battery'),
  V('m_bms', 'Battery board and BMS mass', 'kg', 0.12, 5, 'pct', 'battery'),
  V('m_eps', 'EPS board mass', 'kg', 0.09, 5, 'pct', 'eps'),
  V('m_obc', 'On-board computer mass', 'kg', 0.07, 5, 'pct', 'cdh'),
  V('m_adcs', 'ADCS unit mass (wheels + star tracker)', 'kg', 1.05, 3, 'pct', 'adcs'),
  V('k_inertia', 'Inertia per unit mass (slew axis)', 'm²', 0.0105, 10, 'pct', 'adcs'),
  V('torque', 'Reaction wheel torque', 'N·m', 0.002, 5, 'pct', 'adcs'),
  V('m_uhf', 'UHF radio and antenna mass', 'kg', 0.14, 5, 'pct', 'uhf'),
  V('m_sband', 'S-band radio and patch mass', 'kg', 0.21, 5, 'pct', 'sband'),
  V('p_sband', 'S-band transmit power draw', 'W', 9.5, 5, 'pct', 'sband'),
  V('duty_tx', 'S-band transmit duty cycle', '', 0.06, 0, 'abs', 'mission'),
  V('passes', 'Ground passes per day', 'count', 4, 0, 'abs', 'mission'),
  V('pass_min', 'Usable minutes per pass', 'min', 8.5, 10, 'pct', 'mission'),
  V('rate_mbps', 'S-band downlink rate', 'Mbit/s', 12, 5, 'pct', 'sband'),
  V('link_eff', 'Link efficiency (protocol, retries)', '', 0.7, 10, 'pct', 'sband'),
  V('m_cam', 'Payload camera mass', 'kg', 1.45, 4, 'pct', 'camera'),
  V('p_cam', 'Camera power while imaging', 'W', 7.8, 8, 'pct', 'camera'),
  V('duty_cam', 'Imaging duty cycle', '', 0.18, 0, 'abs', 'mission'),
  V('images', 'Images per day', 'count', 120, 0, 'abs', 'mission'),
  V('mb_img', 'Compressed image size', 'MB', 12, 5, 'pct', 'camera'),
  V('r_cam', 'Camera detector to radiator thermal resistance', 'K/W', 1.4, 10, 'pct', 'thermal'),
  V('m_therm', 'Thermal hardware mass (straps, MLI)', 'kg', 0.18, 10, 'pct', 'thermal'),
  V('r_batt', 'Battery to sink thermal resistance', 'K/W', 7.0, 10, 'pct', 'thermal'),
  V('p_heater', 'Battery heater average power', 'W', 3.0, 15, 'pct', 'thermal'),
  V('t_hot', 'Hot-case sink temperature', '°C', 18, 3, 'abs', 'mission'),
  V('t_cold', 'Cold-case sink temperature', '°C', -14, 3, 'abs', 'mission'),
  V('p_bus', 'Bus average load (OBC, EPS, UHF RX)', 'W', 3.9, 8, 'pct', 'eps'),
  V('p_adcs', 'ADCS average power', 'W', 2.4, 10, 'pct', 'adcs'),
  V('f_ref', 'Reference first mode at 6.0 kg (FEM)', 'Hz', 165, 8, 'pct', 'structure'),
  V('t_peak', 'Peak event duration (imaging + downlink in eclipse)', 'h', 0.25, 0, 'abs', 'mission'),
  V('t_ecl', 'Eclipse duration', 'h', 0.592, 1, 'pct', 'mission')
];
const D = (id, name, unit, formula, system) => ({ id, name, unit, formula, system });
const derived = [
  D('m_batt', 'Battery pack mass', 'kg', 'n_cells * m_cell + m_bms', 'battery'),
  D('m_total', 'Total wet mass', 'kg', 'sum(m_struct, m_harness, m_fast, m_panels, m_batt, m_eps, m_obc, m_adcs, m_uhf, m_sband, m_cam, m_therm)', 'kestrel'),
  D('f1', 'First natural frequency', 'Hz', 'f_ref * sqrt(6.0 / m_total)', 'structure'),
  D('p_gen', 'Orbit-average generated power', 'W', 'area_cells * eff_cells * 1361 * cos_avg * sun_frac', 'solar'),
  D('p_cons', 'Orbit-average consumed power', 'W', 'p_bus + p_adcs + p_cam * duty_cam + p_sband * duty_tx + p_heater', 'eps'),
  D('pwr_ratio', 'Power generation / consumption', '', 'p_gen / p_cons', 'eps'),
  D('e_batt', 'Battery energy (BOL)', 'Wh', 'n_cells * cap_ah * v_cell', 'battery'),
  D('p_ecl', 'Eclipse load', 'W', 'p_bus + p_adcs + p_heater', 'eps'),
  D('p_peak', 'Peak discharge load', 'W', 'p_ecl + p_cam + p_sband', 'eps'),
  D('dod_peak', 'Depth of discharge, worst eclipse with peak event', '', '(p_ecl * t_ecl + (p_cam + p_sband) * t_peak) / (e_batt * eta_batt)', 'battery'),
  D('i_cell', 'Peak cell current', 'A', 'p_peak / (n_cells * v_cell)', 'battery'),
  D('p_diss', 'Battery heat dissipation at peak', 'W', 'n_cells * r_int * sq(i_cell) + p_peak * (1 - eta_batt)', 'battery'),
  D('t_batt_hot', 'Battery temperature, hot case', '°C', 't_hot + r_batt * p_diss', 'thermal'),
  D('t_batt_cold', 'Battery temperature, cold case', '°C', 't_cold + r_batt * (p_heater + p_ecl * (1 - eta_batt))', 'thermal'),
  D('t_cam', 'Camera detector temperature, hot case', '°C', 't_hot + r_cam * p_cam', 'thermal'),
  D('inertia', 'Slew-axis inertia', 'kg·m²', 'k_inertia * m_total', 'adcs'),
  D('t_slew', '30° slew time (bang-bang)', 's', '2 * sqrt(0.5236 * inertia / torque)', 'adcs'),
  D('dl_mb', 'Daily downlink capacity', 'MB', 'passes * pass_min * 60 * rate_mbps * link_eff / 8', 'sband'),
  D('img_mb', 'Daily image data', 'MB', 'images * mb_img', 'camera'),
  D('dl_ratio', 'Downlink capacity / image data', '', 'dl_mb / img_mb', 'sband')
];
const R = (id, name, statement, quantity, op, limit, systems, source = '') => ({ id, name, statement, quantity, op, limit, systems, kind: 'numeric', source, stage: 'Released' });
const Q = (id, name, statement, systems) => ({ id, name, statement, systems, kind: 'qualitative', stage: 'Released' });
const requirements = [
  R('REQ-1', 'Spacecraft mass ≤ 12.0 kg', 'The spacecraft shall have a total mass of no more than {12.0 kg} at launch.', 'm_total', '<=', 12.0, ['kestrel'], 'CDS Rev 14.1, 6U'),
  R('REQ-2', 'Mass within program allocation', 'The spacecraft total mass shall not exceed the program allocation of {6.9 kg}, including uncertainty.', 'm_total', '<=', 6.9, ['kestrel']),
  R('REQ-3', 'First natural frequency ≥ 142 Hz', 'The spacecraft first natural frequency in the stowed configuration shall be at least {142 Hz}.', 'f1', '>=', 142, ['structure']),
  R('REQ-4', 'Orbit-average power margin ≥ 25%', 'Orbit-average generated power shall exceed orbit-average consumption by at least {25%}.', 'pwr_ratio', '>=', 1.25, ['eps', 'solar']),
  R('REQ-5', 'Depth of discharge ≤ 15%', 'Battery depth of discharge during a worst-case eclipse with a peak event shall not exceed {15%}.', 'dod_peak', '<=', 0.15, ['battery']),
  R('REQ-6', 'Battery hot case ≤ 40 °C', 'Battery cell temperature shall not exceed {40 °C} in the hot operational case.', 't_batt_hot', '<=', 40, ['battery', 'thermal']),
  R('REQ-7', 'Battery cold case ≥ 0 °C', 'Battery cell temperature shall remain at or above {0 °C} in the cold operational case.', 't_batt_cold', '>=', 0, ['battery', 'thermal']),
  R('REQ-8', 'Camera detector ≤ 35 °C', 'The camera detector temperature shall not exceed {35 °C} while imaging in the hot case.', 't_cam', '<=', 35, ['camera', 'thermal']),
  R('REQ-9', '30° slew ≤ 12 s', 'The spacecraft shall complete a {30°} slew in no more than {12 s}.', 't_slew', '<=', 12, ['adcs']),
  R('REQ-10', 'Downlink all imagery daily', 'Daily downlink capacity shall be at least {100%} of daily compressed image data.', 'dl_ratio', '>=', 1.0, ['sband', 'camera']),
  R('REQ-11', 'Battery energy ≥ 85 Wh', 'The battery shall store at least {85 Wh} at beginning of life.', 'e_batt', '>=', 85, ['battery']),
  Q('REQ-12', 'Battery protection circuits', 'The battery pack shall provide overcharge, overdischarge and short-circuit protection.', ['battery']),
  Q('REQ-13', 'Cell vacuum screening', 'Battery cells shall pass vacuum leak screening before integration.', ['battery']),
  Q('REQ-14', 'Keyed payload connector', 'The payload connector shall be keyed to prevent mis-mating.', ['camera']),
  Q('REQ-15', 'Payload random vibration', 'The payload shall survive qualification-level random vibration without degradation.', ['camera']),
  Q('REQ-16', 'Payload EMC with UHF', 'The payload shall not desensitise the UHF receiver by more than 3 dB.', ['camera', 'uhf']),
  Q('REQ-17', 'Thermal strap workmanship', 'Thermal strap interfaces shall be bonded and inspected per the workmanship standard.', ['thermal']),
  Q('REQ-18', 'Fits 6U dispenser envelope', 'The spacecraft shall fit within the 6U dispenser envelope.', ['structure']),
  Q('REQ-19', 'Deployment inhibit timer', 'Deployables shall not deploy until at least 30 minutes after ejection.', ['structure']),
  Q('REQ-20', 'UHF beacon', 'The UHF beacon shall transmit the callsign at least every 60 s.', ['uhf']),
  Q('REQ-21', 'Telemetry storage', 'The on-board computer shall store at least 48 h of housekeeping telemetry.', ['cdh']),
  Q('REQ-22', 'Pointing accuracy', 'The ADCS shall point the payload boresight within 0.1° (3σ) during imaging.', ['adcs'])
];
const T = (id, name, hours, verifies, plan) => ({ id, name, hours, verifies, plan, lastRun: 'Pass' });
const tests = [
  T('TCS-1', 'Mass properties measurement', 6, ['REQ-1', 'REQ-2'], 'Integration'),
  T('TCS-2', 'Day-in-the-life power test', 30, ['REQ-4', 'REQ-5'], 'System'),
  T('TCS-3', 'Solar array I-V flash test', 8, ['REQ-4'], 'Unit'),
  T('TCS-4', 'Battery capacity and DoD cycling', 40, ['REQ-5', 'REQ-11'], 'Unit'),
  T('TCS-5', 'Battery protection circuit test', 6, ['REQ-12'], 'Unit'),
  T('TCS-6', 'Cell vacuum leak screening', 16, ['REQ-13'], 'Unit'),
  T('TCS-7', 'Thermal vacuum cycling (system)', 120, ['REQ-6', 'REQ-7', 'REQ-8', 'REQ-4'], 'System'),
  T('TCS-8', 'Payload thermal balance', 24, ['REQ-8'], 'Unit'),
  T('TCS-9', 'Battery thermal chamber test', 18, ['REQ-6', 'REQ-7'], 'Unit'),
  T('TCS-10', 'Sine and random vibration with modal survey', 20, ['REQ-3', 'REQ-15'], 'System'),
  T('TCS-11', 'Payload unit random vibration', 8, ['REQ-15'], 'Unit'),
  T('TCS-12', 'ADCS hardware-in-the-loop slew test', 10, ['REQ-9', 'REQ-22'], 'System'),
  T('TCS-13', 'RF end-to-end downlink test', 8, ['REQ-10'], 'System'),
  T('TCS-14', 'Payload connector inspection', 2, ['REQ-14'], 'Inspection'),
  T('TCS-15', 'Thermal workmanship inspection', 3, ['REQ-17'], 'Inspection'),
  T('TCS-16', 'EMC self-compatibility test', 14, ['REQ-16'], 'System'),
  T('TCS-17', 'Dispenser fit check', 3, ['REQ-18'], 'Integration'),
  T('TCS-18', 'Deployment inhibit functional test', 4, ['REQ-19'], 'System'),
  T('TCS-19', 'UHF beacon functional test', 2, ['REQ-20'], 'System'),
  T('TCS-20', 'OBC storage soak test', 48, ['REQ-21'], 'Unit')
];
const systems = [
  { id: 'kestrel', name: 'Kestrel-6U', parent: null, color: '#64748b' },
  { id: 'structure', name: 'Structure', parent: 'kestrel', color: '#6366f1' },
  { id: 'eps', name: 'Electrical Power', parent: 'kestrel', color: '#f59e0b' },
  { id: 'solar', name: 'Solar Arrays', parent: 'eps', color: '#f59e0b' },
  { id: 'battery', name: 'Battery Pack', parent: 'eps', color: '#ef4444' },
  { id: 'cdh', name: 'Command & Data Handling', parent: 'kestrel', color: '#10b981' },
  { id: 'adcs', name: 'ADCS', parent: 'kestrel', color: '#06b6d4' },
  { id: 'comms', name: 'Communications', parent: 'kestrel', color: '#8b5cf6' },
  { id: 'uhf', name: 'UHF Radio', parent: 'comms', color: '#8b5cf6' },
  { id: 'sband', name: 'S-band Downlink', parent: 'comms', color: '#8b5cf6' },
  { id: 'camera', name: 'Payload Camera', parent: 'kestrel', color: '#ec4899' },
  { id: 'thermal', name: 'Thermal Control', parent: 'kestrel', color: '#f97316' },
  { id: 'mission', name: 'Mission & Environment', parent: 'kestrel', color: '#94a3b8' }
];
const branches = [
  { id: 'payload-camera-v2', name: 'payload-camera-v2', author: 'Priya Raman', title: 'Upgrade to camera v2 (higher-res sensor)', change: { m_cam: { nominal: 1.63 }, p_cam: { nominal: 9.9 }, mb_img: { nominal: 15.5 } } },
  { id: 'battery-cell-swap', name: 'battery-cell-swap', author: 'Marcus Webb', title: 'Swap to 3.5 Ah cells (supply change)', change: { cap_ah: { nominal: 3.5 }, m_cell: { nominal: 0.0485 }, r_int: { nominal: 0.038 } } },
  { id: 'thermal-strap-redesign', name: 'thermal-strap-redesign', author: 'Ana Ortiz', title: 'Copper strap to graphite, camera to radiator', change: { r_cam: { nominal: 1.12 }, m_therm: { nominal: 0.21 } } }
];
const model = { program: 'Kestrel-6U', values, derived, requirements, tests, systems, branches, notes: 'Synthetic program. Limits marked CDS from CubeSat Design Specification Rev 14.1; other values typical datasheet figures; tolerances and allocations are assumptions.' };
writeFileSync('data/model.json', JSON.stringify(model, null, 1));
console.log(values.length, 'values', derived.length, 'derived', requirements.length, 'requirements', tests.length, 'tests');
