export function NavBar() {
  return (
    <div style={{ width: '100vw' }} className="fixed top-0 left-0 right-0 z-50 px-4 pt-3">
      <div className="navbar bg-base-100 shadow-md rounded-box min-h-0 py-2 px-3">
        {/* Left: Logo + breadcrumb */}
        <div className="navbar-start gap-3">
          <div className="avatar placeholder">
            <div className="bg-indigo-600 text-white rounded-lg w-8 text-sm font-bold flex items-center justify-center">
              <span>S</span>
            </div>
          </div>

          <div className="flex items-center gap-2 text-sm">
            <span className="font-semibold">Sentinel</span>
            <span className="text-base-content/30">/</span>
            <span className="text-base-content/60">Op Raven</span>
            <span className="text-base-content/30">·</span>
            <span className="text-base-content/60">COA-B</span>
            <span className="text-base-content/30">·</span>
            <span className="text-base-content/40">Sandbox 03</span>
          </div>
        </div>

        {/* Right: Actions */}
        <div className="navbar-end gap-1">
          <button className="btn btn-sm btn-ghost flex items-center gap-1.5 text-red-500 hover:bg-red-50">
            <span className="w-2 h-2 rounded-full bg-red-500 inline-block" />
            <span className="font-medium">Detections</span>
            <span className="bg-red-100 text-red-600 text-xs font-semibold px-1.5 py-0.5 rounded">
              6
            </span>
          </button>

          <div className="divider divider-horizontal mx-0" />

          <button className="btn btn-sm btn-ghost font-normal">Wargame</button>
          <button className="btn btn-sm btn-ghost font-normal">Terrain</button>
          <button className="btn btn-sm btn-ghost font-normal">Replay</button>

          <div className="divider divider-horizontal mx-0" />

          <button className="btn btn-sm bg-indigo-600 hover:bg-indigo-700 text-white border-none gap-1.5">
            <svg
              stroke="currentColor"
              fill="currentColor"
              strokeWidth="0"
              viewBox="4 4 18 18"
              height="1em"
              width="1em"
              xmlns="http://www.w3.org/2000/svg"
            >
              <path fill="none" d="M0 0h24v24H0z" />
              <path d="M18 15v3H6v-3H4v3c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2v-3h-2zM7 9l1.41 1.41L11 7.83V16h2V7.83l2.59 2.58L17 9l-5-5-5 5z" />
            </svg>
            Export
          </button>
        </div>
      </div>
    </div>
  );
}
