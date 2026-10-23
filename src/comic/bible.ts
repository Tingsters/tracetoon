/**
 * Default casts. Each agent becomes a recurring character; the developer and a
 * small "bug" antagonist round out the cast. A repo keeps its bible on the assets
 * branch, so the same characters return in every episode.
 */
import type { CastMember, SeriesBible, Species, Theme } from './types.ts';

interface Role {
  name: string;
  species: Species;
  description: string;
  palette: string[];
}

const AGENT_KEYS = ['Claude Code', 'Codex', 'Antigravity', 'Antigravity CLI'] as const;

const CASTS: Record<
  Theme,
  {
    agents: Record<string, Role>;
    fallback: Role;
    human: Role;
    bug: Role;
    title: string;
    style: string;
  }
> = {
  pets: {
    title: 'Pull Request Pets',
    style:
      'Sunday-strip cartoon comic panel, cute cartoon animal characters, clean confident line art, warm flat colors, cozy home office',
    agents: {
      'Claude Code': {
        name: 'Kit',
        species: 'fox',
        description:
          'a small orange fox with a cream chest, big curious eyes and a fluffy tail, wears a tiny terracotta scarf',
        palette: ['#E8833A', '#FFF1E0', '#B4532A'],
      },
      Codex: {
        name: 'Pixel',
        species: 'cat',
        description: 'a sleek blue-grey cat with bright green eyes and a tiny headset',
        palette: ['#5B7FA6', '#E8F0F8', '#2E4A66'],
      },
      Antigravity: {
        name: 'Orbit',
        species: 'otter',
        description:
          'a cheerful brown otter who floats in the air, with a small glowing pendant',
        palette: ['#8B5E3C', '#F3E3D3', '#3BB273'],
      },
    },
    fallback: {
      name: 'Biscuit',
      species: 'dog',
      description: 'a fluffy golden puppy with floppy ears',
      palette: ['#D9A441', '#FFF4DC', '#8A5A12'],
    },
    human: {
      name: 'Sam',
      species: 'human',
      description: 'a friendly developer in a hoodie with headphones around their neck',
      palette: ['#7A5C99', '#F2E6FF', '#3D2B52'],
    },
    bug: {
      name: 'Glitch',
      species: 'beetle',
      description: 'a tiny mischievous red beetle with a smug grin',
      palette: ['#C0392B', '#FADBD8', '#641E16'],
    },
  },
  mecha: {
    title: 'Merge Frame',
    style:
      'anime mecha 4-koma comic panel, sleek giant robots, dramatic angles, crisp line art, cel shading, bright hangar lights',
    agents: {
      'Claude Code': {
        name: 'Kitsune-01',
        species: 'mecha',
        description:
          'a white and orange humanoid mecha with fox-ear antennas and a glowing amber visor',
        palette: ['#F4F4F4', '#E8833A', '#2B2B2B'],
      },
      Codex: {
        name: 'CX Drone',
        species: 'drone',
        description:
          'a nimble blue support drone with four rotors and a single green lens',
        palette: ['#5B7FA6', '#DDE8F3', '#1C2B3A'],
      },
      Antigravity: {
        name: 'Gravity Frame',
        species: 'mecha',
        description: 'a green levitating mecha with floating shoulder rings',
        palette: ['#3BB273', '#E3F6EC', '#1D5B3A'],
      },
    },
    fallback: {
      name: 'Unit-K9',
      species: 'robot',
      description: 'a sturdy yellow utility robot',
      palette: ['#D9A441', '#FFF4DC', '#5C3D0A'],
    },
    human: {
      name: 'Pilot Sam',
      species: 'human',
      description: 'a mecha pilot in a purple flight suit with a headset',
      palette: ['#7A5C99', '#F2E6FF', '#3D2B52'],
    },
    bug: {
      name: 'Glitch Kaiju',
      species: 'kaiju',
      description: 'a small red bug-like kaiju made of tangled wires',
      palette: ['#C0392B', '#FADBD8', '#641E16'],
    },
  },
  scifi: {
    title: 'Starship Changelog',
    style:
      'anime sci-fi 4-koma comic panel, cozy starship bridge, holographic screens, clean line art, cel shading, deep blue and neon accents',
    agents: {
      'Claude Code': {
        name: 'KIT-7',
        species: 'robot',
        description:
          'a friendly round robot with an orange glowing face screen and fox-shaped antenna',
        palette: ['#E8833A', '#FFF1E0', '#30343F'],
      },
      Codex: {
        name: 'Probe C',
        species: 'drone',
        description: 'a hovering blue scout probe with a single green eye',
        palette: ['#5B7FA6', '#E8F0F8', '#1C2B3A'],
      },
      Antigravity: {
        name: 'ORBIT',
        species: 'alien',
        description: 'a gentle green alien navigator who floats in zero gravity',
        palette: ['#3BB273', '#E3F6EC', '#1D5B3A'],
      },
    },
    fallback: {
      name: 'Comet',
      species: 'robot',
      description: 'a small golden maintenance bot',
      palette: ['#D9A441', '#FFF4DC', '#5C3D0A'],
    },
    human: {
      name: 'Commander Sam',
      species: 'human',
      description: 'a starship commander in a purple uniform',
      palette: ['#7A5C99', '#F2E6FF', '#3D2B52'],
    },
    bug: {
      name: 'Space Gremlin',
      species: 'beetle',
      description: 'a tiny red space gremlin that chews on cables',
      palette: ['#C0392B', '#FADBD8', '#641E16'],
    },
  },
  office: {
    title: 'Open Plan',
    style:
      'workplace sitcom comic panel, expressive cartoon people, clean line art, warm flat colors, open-plan office',
    agents: {
      'Claude Code': {
        name: 'Kit',
        species: 'human',
        description:
          'an upbeat engineer with copper-red hair in a messy bun, round glasses and a terracotta scarf',
        palette: ['#E8833A', '#FFF1E0', '#B4532A'],
      },
      Codex: {
        name: 'Pixel',
        species: 'human',
        description:
          'a calm, precise engineer with a slate-blue bob, green eyes and a tiny headset',
        palette: ['#5B7FA6', '#E8F0F8', '#2E4A66'],
      },
      Antigravity: {
        name: 'Orbit',
        species: 'human',
        description:
          'a cheerful engineer with curly brown hair, a green pendant and a habit of floating ideas on a whiteboard',
        palette: ['#8B5E3C', '#F3E3D3', '#3BB273'],
      },
    },
    fallback: {
      name: 'Biscuit',
      species: 'human',
      description: 'a friendly new hire with golden curls and a lanyard full of badges',
      palette: ['#D9A441', '#FFF4DC', '#8A5A12'],
    },
    human: {
      name: 'Sam',
      species: 'human',
      description:
        'a friendly team lead in a purple hoodie with headphones around their neck',
      palette: ['#7A5C99', '#F2E6FF', '#3D2B52'],
    },
    bug: {
      name: 'Glitch',
      species: 'robot',
      description: 'a tiny mischievous red robot gremlin that hides in the server rack',
      palette: ['#C0392B', '#FADBD8', '#641E16'],
    },
  },
  heist: {
    title: 'The Merge Job',
    style:
      'heist caper comic panel, stylish crew, dramatic lighting, blueprints and vault doors, bold graphic shapes',
    agents: {
      'Claude Code': {
        name: 'Kit',
        species: 'human',
        description:
          'the planner: a sharp-eyed crew member with copper-red hair, a long coat and a terracotta scarf',
        palette: ['#E8833A', '#FFF1E0', '#B4532A'],
      },
      Codex: {
        name: 'Pixel',
        species: 'human',
        description:
          'the hacker: slate-blue hair, green-tinted goggles and a laptop covered in stickers',
        palette: ['#5B7FA6', '#E8F0F8', '#2E4A66'],
      },
      Antigravity: {
        name: 'Orbit',
        species: 'human',
        description: 'the acrobat: curly brown hair, a green harness and grappling gear',
        palette: ['#8B5E3C', '#F3E3D3', '#3BB273'],
      },
    },
    fallback: {
      name: 'Biscuit',
      species: 'human',
      description: 'the getaway driver with golden curls and driving gloves',
      palette: ['#D9A441', '#FFF4DC', '#8A5A12'],
    },
    human: {
      name: 'Sam',
      species: 'human',
      description:
        'the mastermind in a purple suit jacket with headphones around their neck',
      palette: ['#7A5C99', '#F2E6FF', '#3D2B52'],
    },
    bug: {
      name: 'Glitch',
      species: 'human',
      description: 'a rival safecracker in a red mask with a smug grin',
      palette: ['#C0392B', '#FADBD8', '#641E16'],
    },
  },
  fantasy: {
    title: 'Quest Log',
    style:
      'fantasy adventure comic panel, heroic party, castles and enchanted forests, rich storybook colors',
    agents: {
      'Claude Code': {
        name: 'Kit',
        species: 'human',
        description:
          'a young wizard with copper-red hair, an amber-tipped staff and a terracotta scarf',
        palette: ['#E8833A', '#FFF1E0', '#B4532A'],
      },
      Codex: {
        name: 'Pixel',
        species: 'human',
        description:
          'a precise ranger with slate-blue hair, green eyes and a rune-carved bow',
        palette: ['#5B7FA6', '#E8F0F8', '#2E4A66'],
      },
      Antigravity: {
        name: 'Orbit',
        species: 'human',
        description:
          'a levitating monk with curly brown hair and a glowing green pendant',
        palette: ['#8B5E3C', '#F3E3D3', '#3BB273'],
      },
    },
    fallback: {
      name: 'Biscuit',
      species: 'human',
      description: 'a cheerful squire with golden curls and an oversized helmet',
      palette: ['#D9A441', '#FFF4DC', '#8A5A12'],
    },
    human: {
      name: 'Sam',
      species: 'human',
      description: 'the party leader in a purple cloak with a map case',
      palette: ['#7A5C99', '#F2E6FF', '#3D2B52'],
    },
    bug: {
      name: 'Glitch',
      species: 'kaiju',
      description: 'a tiny mischievous red imp with bat wings and a smug grin',
      palette: ['#C0392B', '#FADBD8', '#641E16'],
    },
  },
};

const NEGATIVE =
  'no text, no letters, no words, no speech bubbles, no captions, no signatures, no watermarks, no logos, no real people';

function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function member(role: Role, kind: CastMember['role'], agent?: string): CastMember {
  return {
    id: slug(role.name),
    name: role.name,
    role: kind,
    agent,
    species: role.species,
    description: role.description,
    palette: role.palette,
  };
}

function roleFor(theme: Theme, agent: string): Role {
  const t = CASTS[theme];
  const key = AGENT_KEYS.find((k) => agent.startsWith(k.split(' ')[0]!)) ?? agent;
  return (
    t.agents[key] ??
    t.agents[key.split(' ')[0]!] ?? {
      ...t.fallback,
      name: `${t.fallback.name} (${agent})`,
    }
  );
}

export function defaultBible(
  series: string,
  theme: Theme,
  agents: string[],
): SeriesBible {
  const t = CASTS[theme];
  const bible: SeriesBible = {
    v: 1,
    series,
    title: t.title,
    theme,
    style: t.style,
    negative: NEGATIVE,
    cast: [member(t.human, 'human'), member(t.bug, 'extra')],
  };
  return addAgents(bible, agents);
}

/** Give any agent not yet in the cast its own character. */
export function addAgents(bible: SeriesBible, agents: string[]): SeriesBible {
  for (const agent of agents) {
    const label = agent === 'Antigravity CLI' ? 'Antigravity' : agent;
    if (bible.cast.some((c) => c.agent === label)) continue;
    const m = member(roleFor(bible.theme, label), 'agent', label);
    while (bible.cast.some((c) => c.id === m.id)) m.id += '-2';
    bible.cast.push(m);
  }
  return bible;
}
