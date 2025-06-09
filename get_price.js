const getSolTokenPrice = async () => {
    const tokenIdSol = ['So11111111111111111111111111111111111111112', 'HH5CWAmkkKJQvpnHdgaC3iZ2s5E3DxaQBXrX79Ljate8']
    const tokenIdSolStr = tokenIdSol.map(tok => `"${tok}"`).join(',')
    const chainId = 1399811149

    const headers = {
        accept: 'application/json, multipart/mixed',
        'accept-language': 'en-US,en;q=0.9',
        authorization: '541ea71b3fea64c808e3b80ec20de92591949389',
        'content-type': 'application/json',
        'user-agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
    }

    const query = ` 
        {
            filterTokens(
            filters: {
                network: [${chainId}]
            }
            limit: 200
            tokens:[${tokenIdSolStr}]
            ) {
            results {
                priceUSD
                token {
                address
                symbol
                name
                }
            }
            }
        }
        `

    const response = await fetch('https://graph.defined.fi/graphql', {
        method: 'POST',
        headers: headers,
        body: JSON.stringify({ query: query })
    })

    const data = await response.json()
    const results = data?.data?.filterTokens?.results

    const priceData = {}
    if (results && results.length > 0) {
        results.forEach(result => {
            priceData[result['token']['address']] = {
                id: result['token']['address'],
                type: "derivedPrice",
                price: result['priceUSD']
            }
        });
        
        console.log(priceData)
        return priceData
    } else {
        console.error('No data returned for token.')
        return null
    }
}

getSolTokenPrice()
