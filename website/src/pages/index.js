import React from 'react';
import Layout from '@theme/Layout';
function Landing() {
  return (
    <Layout title="Unofficial Rainbow Six API Docs">
      <div
        style={{
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
          height: '50vh',
          fontSize: '20px',
        }}>
        <p>
          More coming soon! For now check out the <a href="/docs/manifest">manifest</a>.
        </p>
      </div>
    </Layout>
  );
}
export default Landing;