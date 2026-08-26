import { bootProvider, delay } from './provider-common.js';

const access = new Map([
  ['NS-POINT-A', { minutes: 13, kilometres: 1.0 }],
  ['NS-CITIZENM', { minutes: 15, kilometres: 1.1 }],
  ['NS-COURTHOUSE', { minutes: 22, kilometres: 1.7 }],
  ['NS-ONE-HUNDRED', { minutes: 18, kilometres: 1.4 }],
]);

const tools = [
  {
    name: 'walkmesh.measure_access',
    title: 'Measure destination access',
    description: 'Calculate walking distance and travel time from candidate places to a final destination address.',
    inputSchema: {
      type: 'object',
      properties: {
        places: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, address: { type: 'string' } } } },
        target: { type: 'string' },
        method: { type: 'string', enum: ['walking', 'cycling', 'driving'] },
      },
      required: ['places', 'target'],
    },
    annotations: { readOnlyHint: true, untrustedContentHint: false },
    async execute({ places = [], target, method = 'walking' }, { signal } = {}) {
      await delay(180, signal);
      return {
        target,
        method,
        measures: places.map((place) => ({
          spaceCode: place.id,
          minutes: access.get(place.id)?.minutes ?? 45,
          kilometres: access.get(place.id)?.kilometres ?? 3.5,
        })),
      };
    },
  },
];

bootProvider({ id: 'walkmesh', label: 'WalkMesh', tools, initialMessage: 'Walking access calculation is ready.' });
