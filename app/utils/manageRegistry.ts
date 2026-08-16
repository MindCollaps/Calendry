/**
 * The management area's entity registry — a client mirror of the server's
 * `RESOURCES` (server/utils/resources.ts).
 *
 * WHY A MIRROR AND NOT A FETCH: the server registry holds zod schemas, which
 * do not serialise. What the UI needs is different anyway — labels, column
 * order, help text, which field is a reference to what. The server stays the
 * authority on *validity*; this file is the authority on *presentation*, and a
 * mismatch surfaces as a 400 with a per-field message rather than silent
 * corruption.
 *
 * THIS IS ALSO THE NAVIGATION SOURCE. `useNavEntries()` projects the manage
 * section straight out of this array, so adding an entity here puts it in the
 * sidebar, the index page, the header and the Ctrl+K palette in one edit.
 * There is no second list to keep in sync because there is no second list.
 *
 * Entities appear here only once they have a working editor. An entry whose
 * detail page cannot actually edit the entity would be a nav item that lies.
 */

export type EntityRow = Record<string, unknown>;

export type FieldType =
    | 'text'
    | 'email'
    | 'textarea'
    | 'number'
    | 'boolean'
    | 'date'
    | 'select'
    | 'reference'
    | 'color'
    /** Structured value a bespoke component owns (Constraint.params). */
    | 'json';

export interface FieldDef {
    key: string;
    label: string;
    type: FieldType;
    /** Shown under the control. Use it for domain meaning, not restating the label. */
    help?: string;
    required?: boolean;
    /**
     * Settable at create time only, because the server's `update` schema omits
     * it. Rendering it as an editable field on an existing row would produce a
     * form whose value is silently discarded on save.
     */
    createOnly?: boolean;
    /**
     * Part of the record, but rendered by a bespoke detail component rather than
     * the generic field list.
     *
     * This is what keeps "bespoke" down to one slot: the field still takes part
     * in draft seeding, dirty tracking, payload building and server-error
     * mapping — all of which stay in `useEntityForm` — and only its CONTROL is
     * hand-written. A field left out of the registry entirely would be missing
     * from the draft and silently dropped on save.
     */
    custom?: boolean;
    /** Fixed options, for `select`. */
    options?: { value: string | number; label: string }[];
    /** Which entity to look up, for `reference`. */
    reference?: {
        /** API resource segment, e.g. 'time-grids'. Need not be a managed entity. */
        resource: string;
        label: (row: EntityRow) => string;
        /** Renders an explicit "none" option. */
        nullable?: boolean;
        /** Blank-state text when the referenced entity has no rows yet. */
        emptyHint?: string;
    };
    min?: number;
    max?: number;
    placeholder?: string;
}

export interface ColumnDef {
    key: string;
    label: string;
    format?: 'text' | 'code' | 'boolean' | 'date' | 'number' | 'weekdays' | 'swatch';
    /** Dropped on narrow viewports rather than squeezed. */
    secondary?: boolean;
}

/**
 * A join table hanging off this entity, edited as a SET.
 *
 * Declaring these as data is what stops Offering — which references a Term, a
 * Kind, a Role, plus Groups, Lecturers and Equipment — from needing a bespoke
 * page. It is the hub of the model, but nothing about editing it is structurally
 * new; only the number of relations is.
 */
export interface RelationDef {
    /** Path segment: /api/{entity}/{id}/{key}. Must exist in server RELATIONS. */
    key: string;
    label: string;
    help?: string;
    /** Resource supplying the choices. */
    resource: string;
    /** Column on the join row holding the chosen row's id. */
    valueKey: string;
    optionLabel: (row: EntityRow) => string;
    /** Renders options with their hierarchy visible (Groups). */
    indentTree?: boolean;
    /** Per-row count, for countable equipment. */
    quantity?: { key: string; label: string };
    /**
     * Per-row reference to a second entity — currently only a lecturer's
     * SCHEDULING role (TAXONOMY.md §2), which is vocabulary, never permissions.
     */
    extraReference?: {
        key: string;
        resource: string;
        label: (row: EntityRow) => string;
        placeholder: string;
    };
    emptyHint?: string;
}

export interface ManageEntity {
    /** Route segment AND API resource name — deliberately the same string. */
    key: string;
    /** Permission prefix from the server catalogue, e.g. 'person'. */
    permissionPrefix: string;
    label: string;
    plural: string;
    icon: string;
    /** One line, shown on the section card and as the palette subtitle. */
    description: string;
    /** Extra terms the Ctrl+K fuzzy match should hit. */
    keywords: string[];
    /** Row → human title. Used in lists, delete confirmations and page titles. */
    title: (row: EntityRow) => string;
    columns: ColumnDef[];
    fields: FieldDef[];
    /**
     * True when a Federation can own rows of this entity (TAXONOMY.md §2).
     * Such rows are readable but not writable — the RLS write policy is
     * tenant-only — so the list marks them and the detail renders read-only.
     */
    federationOwnable?: boolean;
    /**
     * Column marking rows provisioning created and the tenant must not delete
     * (Role.isSystem, AccessRole.isSystem).
     */
    systemFlag?: string;
    /** Bespoke detail body, resolved by name. Generic form when absent. */
    detailComponent?: string;
    /**
     * Bespoke LIST body, for an entity whose rows do not read as a flat table.
     * Only Group needs this — a hierarchy shown as a flat list loses the one
     * property that makes it a hierarchy.
     */
    listComponent?: string;
    /**
     * Rows per page. Raised for entities whose list view needs the whole set to
     * be correct (a tree cannot be assembled from page 1 of 4). The list still
     * reports honestly when it did not receive everything.
     */
    listPageSize?: number;
    /** Join tables edited as sets on the detail page. */
    relations?: RelationDef[];
}

export const OFFERING_ENTITY: ManageEntity = {
    key: 'offerings',
    permissionPrefix: 'offering',
    label: 'Offering',
    plural: 'Offerings',
    icon: 'material-symbols:book-outline',
    description: 'What must be scheduled — the recurring demand sessions are placed from.',
    keywords: ['offering', 'course', 'module', 'subject', 'demand', 'curriculum', 'lecture'],
    federationOwnable: true,
    title: (row) => [row.code, row.title].filter(Boolean).join(' · ') || 'Offering',
    columns: [
        { key: 'code', label: 'Code', format: 'code' },
        { key: 'title', label: 'Title' },
        { key: 'frequency', label: 'Sessions', format: 'number' },
        { key: 'durationBlocks', label: 'Blocks', format: 'number' },
        { key: 'isActive', label: 'Active', format: 'boolean' },
    ],
    fields: [
        { key: 'title', label: 'Title', type: 'text', required: true },
        { key: 'code', label: 'Code', type: 'text' },
        {
            key: 'termId',
            label: 'Term',
            type: 'reference',
            required: true,
            // The server's update schema omits termId: moving an Offering between
            // terms would orphan its placed Sessions, which belong to a term.
            createOnly: true,
            reference: {
                resource: 'terms',
                label: (row) => String(row.name),
                emptyHint: 'Create a term first — an offering has to belong to one.',
            },
        },
        {
            key: 'kindId',
            label: 'Kind',
            type: 'reference',
            required: true,
            reference: {
                resource: 'session-kinds',
                label: (row) => String(row.name ?? row.key),
                emptyHint: 'Create a session kind first — lecture, lab, seminar, whatever you call them.',
            },
        },
        {
            key: 'frequency',
            label: 'Sessions per term',
            type: 'number',
            min: 1,
            help: 'Exactly this many sessions must exist. Enforced as a hard constraint.',
        },
        {
            key: 'durationBlocks',
            label: 'Length in blocks',
            type: 'number',
            min: 1,
            help: 'How many consecutive TimeGrid blocks one session occupies.',
        },
        {
            key: 'requiredRoleId',
            label: 'Required role',
            type: 'reference',
            help: 'Scheduling role a lecturer must hold to lead this. Leave unset if it does not matter.',
            reference: {
                resource: 'roles',
                label: (row) => String(row.name ?? row.key),
                nullable: true,
                emptyHint: 'No roles defined yet.',
            },
        },
        {
            key: 'requiredCapacity',
            label: 'Required room capacity',
            type: 'number',
            min: 0,
            help: 'Leave unset to derive it from the assigned groups\' expected sizes.',
        },
        {
            key: 'allowOnline',
            label: 'May be scheduled online',
            type: 'boolean',
            help: 'Lets the solver place this in a virtual room. Online delivery is a virtual room, not a session flag.',
        },
        { key: 'isActive', label: 'Active', type: 'boolean' },
        { key: 'notes', label: 'Notes', type: 'textarea' },
    ],
    relations: [
        {
            key: 'groups',
            label: 'Groups this is for',
            help: 'Nesting propagates: assigning a cohort also blocks its seminars.',
            resource: 'groups',
            valueKey: 'groupId',
            indentTree: true,
            optionLabel: (row) => String(row.name),
            emptyHint: 'No groups defined yet.',
        },
        {
            key: 'lecturers',
            label: 'Who leads it',
            help: 'Optionally state the scheduling role each person fills here.',
            resource: 'persons',
            valueKey: 'personId',
            optionLabel: (row) => `${row.givenName} ${row.familyName}`,
            extraReference: {
                key: 'roleId',
                resource: 'roles',
                label: (row) => String(row.name ?? row.key),
                placeholder: 'Any role',
            },
            emptyHint: 'No people defined yet.',
        },
        {
            key: 'equipment',
            label: 'Equipment it needs',
            help: 'Restricts placement to rooms providing all of it.',
            resource: 'equipment',
            valueKey: 'equipmentId',
            optionLabel: (row) => String(row.name ?? row.key),
            quantity: { key: 'quantity', label: 'Count' },
            emptyHint: 'No equipment defined yet.',
        },
    ],
};

export const CONSTRAINT_ENTITY: ManageEntity = {
    key: 'constraints',
    permissionPrefix: 'constraint',
    label: 'Constraint',
    plural: 'Constraints',
    icon: 'material-symbols:rule-outline',
    description: 'The rules a timetable must respect, and the preferences it should weigh.',
    keywords: ['constraint', 'rule', 'hard', 'soft', 'penalty', 'conflict', 'policy'],
    title: (row) => String(row.name ?? 'Constraint'),
    detailComponent: 'ConstraintBuilder',
    columns: [
        { key: 'name', label: 'Name' },
        { key: 'type', label: 'Type', format: 'code', secondary: true },
        { key: 'severity', label: 'Severity' },
        { key: 'weight', label: 'Weight', format: 'number' },
        { key: 'isEnabled', label: 'Enabled', format: 'boolean' },
    ],
    /*
     * `type`, `severity`, `weight` and `params` are all `custom`: they constrain
     * each other. The chosen type fixes the severity and dictates which
     * parameters exist, and weight is meaningful only when severity is SOFT — a
     * pairing the database CHECK enforces. Rendered as four independent controls
     * they would compose states the server rejects.
     */
    fields: [
        { key: 'name', label: 'Name', type: 'text', required: true },
        { key: 'type', label: 'Rule', type: 'select', required: true, createOnly: true, custom: true },
        { key: 'severity', label: 'Severity', type: 'select', required: true, custom: true },
        { key: 'weight', label: 'Penalty weight', type: 'number', custom: true },
        { key: 'params', label: 'Parameters', type: 'json', custom: true },
        { key: 'isEnabled', label: 'Enabled', type: 'boolean' },
    ],
};

export const MANAGE_ENTITIES: ManageEntity[] = [
    {
        key: 'persons',
        permissionPrefix: 'person',
        label: 'Person',
        plural: 'People',
        icon: 'material-symbols:person-outline',
        description: 'Everyone the timetable places or notifies.',
        keywords: ['people', 'staff', 'student', 'lecturer', 'teacher', 'roster', 'directory'],
        title: (row) => `${row.givenName ?? ''} ${row.familyName ?? ''}`.trim() || 'Person',
        columns: [
            { key: 'familyName', label: 'Family name' },
            { key: 'givenName', label: 'Given name' },
            { key: 'email', label: 'Email', secondary: true },
            { key: 'isActive', label: 'Active', format: 'boolean' },
        ],
        fields: [
            { key: 'givenName', label: 'Given name', type: 'text', required: true },
            { key: 'familyName', label: 'Family name', type: 'text', required: true },
            { key: 'email', label: 'Email', type: 'email' },
            {
                key: 'externalRef',
                label: 'External reference',
                type: 'text',
                help: 'Stable id from an external SIS or LDAP, used to reconcile imports.',
            },
            {
                key: 'timezone',
                label: 'Timezone',
                type: 'text',
                placeholder: 'Europe/Berlin',
                help: 'Display and export only. It never affects grid placement or "same day" logic.',
            },
            { key: 'isActive', label: 'Active', type: 'boolean' },
        ],
        relations: [
            {
                key: 'roles',
                label: 'Scheduling roles',
                help: 'What this person can be scheduled AS — Lecturer, Auditor. Not permissions.',
                resource: 'roles',
                valueKey: 'roleId',
                optionLabel: (row) => String(row.name ?? row.key),
                emptyHint: 'No roles defined yet.',
            },
            {
                key: 'groups',
                label: 'Group memberships',
                help: 'Which cohorts and seminars this person belongs to.',
                resource: 'groups',
                valueKey: 'groupId',
                indentTree: true,
                optionLabel: (row) => String(row.name),
                emptyHint: 'No groups defined yet.',
            },
        ],
    },

    {
        key: 'roles',
        permissionPrefix: 'role',
        label: 'Role',
        plural: 'Roles',
        icon: 'material-symbols:badge-outline',
        // The Role/AccessRole distinction is load-bearing (TAXONOMY.md §2 vs §4)
        // and the two share a word, so the UI says which one this is.
        description: 'Scheduling vocabulary — Lecturer, Auditor. Not permissions.',
        keywords: ['role', 'lecturer', 'auditor', 'vocabulary', 'title'],
        title: (row) => String(row.name ?? 'Role'),
        systemFlag: 'isSystem',
        columns: [
            { key: 'key', label: 'Key', format: 'code' },
            { key: 'name', label: 'Name' },
            { key: 'description', label: 'Description', secondary: true },
        ],
        fields: [
            {
                key: 'key',
                label: 'Key',
                type: 'text',
                required: true,
                createOnly: true,
                help: 'Stable identifier used by imports and constraints. Cannot be changed later.',
            },
            { key: 'name', label: 'Name', type: 'text', required: true },
            { key: 'description', label: 'Description', type: 'textarea' },
        ],
    },

    {
        key: 'rooms',
        permissionPrefix: 'room',
        label: 'Room',
        plural: 'Rooms',
        icon: 'material-symbols:meeting-room-outline',
        description: 'Physical and virtual spaces sessions can be placed in.',
        keywords: ['room', 'space', 'hall', 'lab', 'venue', 'building', 'capacity'],
        federationOwnable: true,
        title: (row) => [row.code, row.name].filter(Boolean).join(' · ') || 'Room',
        columns: [
            { key: 'code', label: 'Code', format: 'code' },
            { key: 'name', label: 'Name' },
            { key: 'capacity', label: 'Capacity', format: 'number' },
            { key: 'location', label: 'Location', secondary: true },
            { key: 'isActive', label: 'Active', format: 'boolean' },
        ],
        fields: [
            { key: 'code', label: 'Code', type: 'text', required: true },
            { key: 'name', label: 'Name', type: 'text', required: true },
            { key: 'capacity', label: 'Capacity', type: 'number', min: 0 },
            { key: 'location', label: 'Location', type: 'text' },
            {
                key: 'ranking',
                label: 'Ranking',
                type: 'number',
                help: 'Desirability. Soft constraints minimise use of high-ranking rooms.',
            },
            { key: 'isVirtual', label: 'Virtual', type: 'boolean' },
            { key: 'isActive', label: 'Active', type: 'boolean' },
        ],
        relations: [
            {
                key: 'equipment',
                label: 'Equipment in this room',
                help: 'What this room provides. Offerings requiring it can only be placed here.',
                resource: 'equipment',
                valueKey: 'equipmentId',
                optionLabel: (row) => String(row.name ?? row.key),
                quantity: { key: 'quantity', label: 'Count' },
                emptyHint: 'No equipment defined yet.',
            },
        ],
    },

    {
        key: 'equipment',
        permissionPrefix: 'equipment',
        label: 'Equipment',
        plural: 'Equipment',
        icon: 'material-symbols:videocam-outline',
        description: 'Feature tags rooms provide and offerings require.',
        keywords: ['equipment', 'feature', 'projector', 'lab', 'tag', 'facility'],
        federationOwnable: true,
        title: (row) => String(row.name ?? 'Equipment'),
        columns: [
            { key: 'key', label: 'Key', format: 'code' },
            { key: 'name', label: 'Name' },
            { key: 'description', label: 'Description', secondary: true },
        ],
        fields: [
            {
                key: 'key',
                label: 'Key',
                type: 'text',
                required: true,
                createOnly: true,
                help: 'Stable identifier used by imports. Cannot be changed later.',
            },
            { key: 'name', label: 'Name', type: 'text', required: true },
            { key: 'description', label: 'Description', type: 'textarea' },
        ],
    },

    {
        key: 'groups',
        permissionPrefix: 'group',
        label: 'Group',
        plural: 'Groups',
        icon: 'material-symbols:account-tree-outline',
        description: 'Cohorts and their nested sub-groups.',
        keywords: ['group', 'cohort', 'class', 'section', 'seminar', 'nesting', 'hierarchy', 'tree'],
        title: (row) => String(row.name ?? 'Group'),
        listComponent: 'GroupTree',
        detailComponent: 'GroupForm',
        // A tree assembled from one page of rows would show orphans whose
        // parents are on page 2. See ManageGroupTree for what happens past this.
        listPageSize: 200,
        columns: [
            { key: 'name', label: 'Name' },
            { key: 'expectedSize', label: 'Expected size', format: 'number' },
            { key: 'description', label: 'Description', secondary: true },
        ],
        fields: [
            { key: 'name', label: 'Name', type: 'text', required: true },
            { key: 'description', label: 'Description', type: 'textarea' },
            {
                key: 'expectedSize',
                label: 'Expected size',
                type: 'number',
                min: 0,
                help: 'Advisory headcount for room-capacity checks. Membership remains the source of truth.',
            },
            {
                key: 'parentGroupId',
                label: 'Parent group',
                type: 'reference',
                // Rendered by ManageGroupForm: the option list depends on WHICH
                // group is being edited, since self and every descendant must be
                // excluded. A static registry entry cannot express that.
                custom: true,
                reference: {
                    resource: 'groups',
                    label: (row) => String(row.name ?? row.id),
                    nullable: true,
                    emptyHint: 'No other groups to nest under yet.',
                },
            },
        ],
    },

    {
        key: 'time-grids',
        permissionPrefix: 'time_grid',
        label: 'Time grid',
        plural: 'Time grids',
        icon: 'material-symbols:grid-on-outline',
        description: 'Block length, blocks per day, and which days this institution teaches on.',
        keywords: ['time grid', 'timegrid', 'blocks', 'periods', 'slots', 'days', 'schedule shape'],
        title: (row) => String(row.name ?? 'Time grid'),
        detailComponent: 'TimeGridEditor',
        columns: [
            { key: 'name', label: 'Name' },
            { key: 'blocksPerDay', label: 'Blocks/day', format: 'number' },
            { key: 'blockLengthMinutes', label: 'Block length', format: 'number' },
            { key: 'activeDays', label: 'Days', format: 'weekdays' },
            { key: 'isDefault', label: 'Default', format: 'boolean' },
        ],
        /*
         * Every field is `custom`: the editor renders them against a live
         * preview of the resulting day, because these numbers are meaningless in
         * isolation — "45 minutes, 8 blocks, break 15" only becomes checkable
         * when you can see it lands at 17:00. They stay declared here so draft
         * seeding, dirty tracking, payload building and server-side field errors
         * all keep working exactly as they do for a generic entity.
         */
        fields: [
            { key: 'name', label: 'Name', type: 'text', required: true, custom: true },
            {
                key: 'blockLengthMinutes',
                label: 'Block length (minutes)',
                type: 'number',
                required: true,
                min: 1,
                custom: true,
            },
            { key: 'blocksPerDay', label: 'Blocks per day', type: 'number', required: true, min: 1, custom: true },
            { key: 'startHour', label: 'Start hour', type: 'number', min: 0, max: 23, custom: true },
            { key: 'startMinute', label: 'Start minute', type: 'number', min: 0, max: 59, custom: true },
            { key: 'breakMinutes', label: 'Break between blocks (minutes)', type: 'number', min: 0, custom: true },
            { key: 'activeDays', label: 'Teaching days', type: 'select', required: true, custom: true },
            { key: 'isDefault', label: 'Default grid', type: 'boolean', custom: true },
        ],
    },

    {
        key: 'session-kinds',
        permissionPrefix: 'session_kind',
        label: 'Session kind',
        plural: 'Session kinds',
        icon: 'material-symbols:label-outline',
        description: 'Your own vocabulary — lecture, lab, seminar. Nothing here is built in.',
        keywords: ['kind', 'type', 'lecture', 'lab', 'seminar', 'exam', 'vocabulary', 'category'],
        title: (row) => String(row.name ?? 'Session kind'),
        columns: [
            { key: 'key', label: 'Key', format: 'code' },
            { key: 'name', label: 'Name' },
            { key: 'color', label: 'Colour', format: 'swatch' },
            { key: 'requiresGroup', label: 'Has groups', format: 'boolean' },
        ],
        fields: [
            {
                key: 'key',
                label: 'Key',
                type: 'text',
                required: true,
                createOnly: true,
                help: 'Stable identifier used by imports and constraints. Cannot be changed later.',
            },
            { key: 'name', label: 'Name', type: 'text', required: true },
            {
                key: 'color',
                label: 'Colour',
                type: 'color',
                help: 'Tints this kind on the schedule. Chips stay legible without it — colour is never the only cue.',
            },
            {
                key: 'requiresGroup',
                label: 'Carries groups',
                type: 'boolean',
                help: 'Whether sessions of this kind are expected to have Groups assigned. Lets a group-based constraint be rejected when aimed at a kind that has none.',
            },
        ],
    },

    OFFERING_ENTITY,
    CONSTRAINT_ENTITY,

    {
        key: 'terms',
        permissionPrefix: 'term',
        label: 'Term',
        plural: 'Terms',
        icon: 'material-symbols:calendar-month-outline',
        description: 'Academic periods sessions are scheduled within.',
        keywords: ['term', 'semester', 'trimester', 'academic', 'year', 'period'],
        title: (row) => String(row.name ?? 'Term'),
        columns: [
            { key: 'name', label: 'Name' },
            { key: 'startDate', label: 'Starts', format: 'date' },
            { key: 'endDate', label: 'Ends', format: 'date' },
        ],
        fields: [
            { key: 'name', label: 'Name', type: 'text', required: true },
            { key: 'startDate', label: 'Start date', type: 'date', required: true },
            { key: 'endDate', label: 'End date', type: 'date', required: true },
            {
                key: 'timeGridId',
                label: 'Time grid',
                type: 'reference',
                help: 'Which grid this term is scheduled on. Falls back to the tenant default when unset.',
                reference: {
                    resource: 'time-grids',
                    label: (row) => String(row.name ?? row.id),
                    nullable: true,
                    emptyHint: 'No time grids configured yet.',
                },
            },
        ],
    },
];


export function findManageEntity(key: string | undefined): ManageEntity | undefined {
    return MANAGE_ENTITIES.find((entity) => entity.key === key);
}

/** The four CRUD permissions for an entity, in catalogue form. */
export function entityPermission(entity: ManageEntity, action: 'read' | 'create' | 'update' | 'delete'): string {
    return `${entity.permissionPrefix}.${action}`;
}

/**
 * Fields the form should render for this mode. `createOnly` fields are dropped
 * on edit because the server's update schema rejects them — rendering them
 * would offer an edit that silently does nothing.
 */
export function fieldsFor(entity: ManageEntity, mode: 'create' | 'edit'): FieldDef[] {
    return mode === 'create' ? entity.fields : entity.fields.filter((field) => !field.createOnly);
}

/** Distinct reference resources a form needs to populate its selects. */
export function referencedResources(entity: ManageEntity): string[] {
    const resources = entity.fields
        .filter((field) => field.type === 'reference' && field.reference)
        .map((field) => field.reference!.resource);

    return [...new Set(resources)];
}
