import type { LogEvent } from '@shared/types'
import { useData } from '../api'

export function Activity() {
  const { data } = useData<LogEvent[]>('events.list', [400], ['events'])
  return (
    <div className="page">
      <h1>Activity</h1>
      <p className="sub">What Polycast did, newest first.</p>
      <div className="card log">
        {!data?.length && <div className="muted">Nothing yet.</div>}
        {data?.map((e) => (
          <div key={e.id} className={`e-${e.level}`}>
            <span className="faint">{new Date(e.ts).toLocaleString()}</span> {e.message}
          </div>
        ))}
      </div>
    </div>
  )
}
