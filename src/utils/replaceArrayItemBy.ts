import assertNever from './assertNever';

/**
 * create new array with first matched item replaced by given value
 */
export default function replaceArrayItemBy<T>(
  array: readonly T[],
  predicate: Parameters<(readonly T[])['findIndex']>[0],
  item: T,
  {
    whenNoMatch = 'append',
  }: { whenNoMatch?: 'append' | 'prepend' | 'ignore' } = {}
): T[] {
  const index = array.findIndex(predicate);
  if (index < 0) {
    switch (whenNoMatch) {
      case 'append':
        return [...array, item];
      case 'prepend':
        return [item, ...array];
      case 'ignore':
        return array.slice();
      default:
        assertNever(whenNoMatch);
        return array.slice();
    }
  }
  return [...array.slice(0, index), item, ...array.slice(index + 1)];
}
