/** Marks text Muse wrote (not the paper's own words), so it isn't mistaken for checked fact. */
export function MuseTag({ from }: { from: string }) {
  return (
    <span className="muse-tag" title={`Muse wrote this from ${from}. It isn't checked against a quote: read the source before citing it.`}>
      Written by Muse
    </span>
  )
}
