import MIcon from './MIcon'

export function EmptyState({ icon = 'box', text }: { icon?: string; text: string }) {
  return (
    <div className="m-empty">
      <MIcon name={icon} size={44} />
      <span>{text}</span>
    </div>
  )
}

export function SkeletonCards({ count = 3 }: { count?: number }) {
  return (
    <>
      {Array.from({ length: count }).map((_, i) => (
        <div className="ck-card" key={i}>
          <div className="m-skel" style={{ height: 18, width: '45%' }} />
          <div className="m-skel" style={{ height: 12, width: '62%', marginTop: 8 }} />
          <div className="m-skel" style={{ height: 12, width: '38%', marginTop: 6 }} />
          <div className="m-skel" style={{ height: 6, marginTop: 12 }} />
        </div>
      ))}
    </>
  )
}
