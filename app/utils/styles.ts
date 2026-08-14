import type { PartialRecord } from '../../types';

/**
 * The colour palette.
 *
 * The two neutral ramps are named by ROLE and by distance from the page ground,
 * not by lightness:
 *
 *   surface0…surface7  the ground and the things stacked on it
 *   content0…content7  what sits on those surfaces — text, icons, hairlines
 *
 * That naming is what makes theming legible. The ramps were previously called
 * `darkgray*` and `lightgray*`, which described their values in one theme and
 * lied in the other: a "light" theme worked by swapping the two ramps, so
 * `$darkgray950` rendered near-white and every call site read backwards.
 * Under role names, `surface1` is the second surface layer in every theme, and
 * only its value changes.
 *
 * The base palette is LIGHT. `dark` swaps the two ramps back. There is
 * deliberately no `light` entry: with a light base it would be an empty
 * override rendering identically to `default`, which is exactly the duplicate
 * that made the original bug invisible.
 */
export const colorsList = {
    //#region neutrals
    white: '#FAFAFA',
    black: '#151515',
    blackAlpha2: '#15151505',
    blackAlpha4: '#1515150a',
    blackAlpha8: '#15151514',
    blackAlpha12: '#1515151f',
    blackAlpha24: '#1515153d',
    blackAlpha36: '#1515155c',
    blackAlpha64: '#151515a3',
    whiteAlpha2: '#FAFAFA05',
    whiteAlpha4: '#FAFAFA0a',
    whiteAlpha8: '#FAFAFA14',
    whiteAlpha12: '#FAFAFA1f',
    whiteAlpha24: '#FAFAFA3d',
    whiteAlpha36: '#FAFAFA5c',
    whiteAlpha64: '#FAFAFAa3',

    // Surfaces: the page ground (surface0) outward. Light in the base theme.
    surface0: '#F7F7FA',
    surface1: '#F2F2F7',
    surface2: '#EDEDF2',
    surface3: '#E6E6EB',
    surface4: '#DEDEE7',
    surface5: '#D5D5E4',
    surface6: '#bfbfc2',
    surface7: '#aaaaac',

    // Content: primary text (content0) through the faintest hairline.
    content0: '#131316',
    content1: '#18181B',
    content2: '#202024',
    content3: '#26262C',
    content4: '#2B2B33',
    content5: '#30303C',
    content6: '#3c3c3f',
    content7: '#525255',

    primary700: '#512da8',
    primary600: '#6743b2',
    primary500: '#7c59bc',
    primary400: '#8f70c6',
    primary300: '#a287d0',

    secondary700: '#2d512a',
    secondary600: '#436743',
    secondary500: '#587c58',
    secondary400: '#719f71',
    secondary300: '#86b287',

    success700: '#46a92d',
    success600: '#57b143',
    success500: '#66bb58',
    success400: '#7dc671',
    success300: '#90d086',

    warning700: '#a97d2d',
    warning600: '#b18c43',
    warning500: '#bb9d58',
    warning400: '#c6af71',
    warning300: '#d0c686',

    error700: '#a92d46',
    error600: '#b14357',
    error500: '#bb5866',
    error400: '#c6717d',
    error300: '#d08690',

    info700: '#2da990',
    info600: '#43b19d',
    info500: '#58bbad',
    info400: '#71c6bb',
    info300: '#86d0c6',
};

export type ColorsList = keyof typeof colorsList;

/**
 * `dark` swaps the two ramps: surfaces take the dark values, content takes the
 * light ones. Nothing else is theme-dependent — the semantic colours read
 * acceptably on both grounds and are deliberately not duplicated here.
 */
export const themesList = {
    dark: {
        surface0: '#131316',
        surface1: '#18181B',
        surface2: '#202024',
        surface3: '#26262C',
        surface4: '#2B2B33',
        surface5: '#30303C',
        surface6: '#3c3c3f',
        surface7: '#525255',

        content0: '#F7F7FA',
        content1: '#F2F2F7',
        content2: '#EDEDF2',
        content3: '#E6E6EB',
        content4: '#DEDEE7',
        content5: '#D5D5E4',
        content6: '#bfbfc2',
        content7: '#aaaaac',
    },
} satisfies Record<string, PartialRecord<ColorsList, string>>;

/** 'default' is the light base; the UI labels it "Light". */
export type ThemesList = keyof typeof themesList | 'default';
